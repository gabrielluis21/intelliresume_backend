import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import session from 'express-session';
import passport from './config/passport';
import authRoutes from './routes/auth';
import { db, auth } from './config/firebase';
import { DecodedIdToken } from 'firebase-admin/auth';

// Carrega as variáveis de ambiente do arquivo .env
dotenv.config();

// Interface para estender o objeto Request do Express e adicionar a propriedade 'user'
interface AuthenticatedRequest extends Request {
  user?: any;
}

// --- Bloco de Inicialização ---
try {
  // --- Configuração do Stripe ---
  const stripeApiKey = process.env.STRIPE_SECRET_KEY;
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const successUrl = process.env.SUCCESS_URL;
  const cancelUrl = process.env.CANCEL_URL;
  const priceId = process.env.STRIPE_PRICE_ID;

  if (!stripeApiKey || !stripeWebhookSecret || !successUrl || !cancelUrl || !priceId) {
    throw new Error("As variáveis de ambiente do Stripe e as URLs devem ser definidas no .env");
  }

  const stripe = new Stripe(stripeApiKey, {
    apiVersion: '2025-09-30.clover', // API version atualizada
    typescript: true,
  });
  console.log('✅ Stripe SDK inicializado com sucesso.');

  // --- Servidor Express ---
  const app = express();
  const port = process.env.PORT || 3000;

  // --- Middleware de Autenticação Firebase ---
  const verifyFirebaseToken = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).send({ error: 'Token de autorização não fornecido ou mal formatado.' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    try {
      req.user = await auth.verifyIdToken(idToken);
      next();
    } catch (error) {
      console.error('Erro ao verificar o token do Firebase:', error);
      return res.status(403).send({ error: 'Token inválido ou expirado.' });
    }
  };

  // --- Middlewares ---
  app.use(cors({ origin: true }));
  app.use(express.json());
  app.use(session({
    secret: process.env.SESSION_SECRET || 'secret',
    resave: false,
    saveUninitialized: false
  }));
  app.use(passport.initialize());
  app.use(passport.session());

  // --- Rotas ---
  app.use('/auth', authRoutes);

  // Webhook deve vir antes do express.json() para usar o corpo raw
  app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'];
    if (!sig) {
      return res.status(400).send('Webhook Error: Signature not found.');
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } catch (err) {
      const message = `Webhook Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
      console.log(`❌ ${message}`);
      return res.status(400).send(message);
    }

    console.log(`✅ Evento recebido: ${event.type}`);

    // Lógica do Webhook
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.userId;
        if (!userId) {
          console.log('❌ Erro: userId não encontrado na metadata da sessão de checkout.');
          break;
        }
        console.log(`🔔 Processando pagamento web para o usuário: ${userId}`);
        try {
          await db.collection('users').doc(userId).update({ isPremium: true, plan: 'premium' });
          console.log(`✅ Usuário ${userId} atualizado para Premium via web.`);
        } catch (err) {
          console.log(`❌ Erro ao atualizar usuário ${userId} no Firestore:`, err);
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        const subscription = await stripe.subscriptions.retrieve((invoice as any).subscription as string);
        const userId = subscription.metadata.appUserId;

        if (!userId) {
            console.log(`❌ Erro: appUserId não encontrado na metadata da assinatura para o cliente: ${customerId}`);
            break;
        }
        
        console.log(`🔔 Processando pagamento mobile para o usuário: ${userId}`);
        try {
            await db.collection('users').doc(userId).update({ isPremium: true, plan: 'premium' });
            console.log(`✅ Usuário ${userId} atualizado para Premium via mobile.`);
        } catch (err) {
            console.log(`❌ Erro ao atualizar usuário ${userId} no Firestore:`, err);
        }
        break;
      }
      default:
        console.log(`🤷‍♀️ Evento não tratado: ${event.type}`);
    }

    res.json({ received: true });
  });

  app.get('/', (req: Request, res: Response) => {
    res.send('IntelliResume Backend is running!');
  });

  // Endpoint 1: Para o App Mobile (PaymentSheet)
  app.post('/api/create-payment-intent', verifyFirebaseToken, async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const userId = user.uid;
    const userEmail = user.email;

    try {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();
      let stripeCustomerId = userDoc.data()?.stripeCustomerId;

      if (!stripeCustomerId) {
        const customer = await stripe.customers.create({
          email: userEmail,
          metadata: { appUserId: userId },
        });
        stripeCustomerId = customer.id;
        await userRef.set({ stripeCustomerId }, { merge: true });
      }

      const ephemeralKey = await stripe.ephemeralKeys.create(
        { customer: stripeCustomerId },
        { apiVersion: '2025-09-30.clover' }
      );

      const subscription = await stripe.subscriptions.create({
          customer: stripeCustomerId,
          items: [{ price: priceId }],
          payment_behavior: 'default_incomplete',
          payment_settings: { save_default_payment_method: 'on_subscription' },
          expand: ['latest_invoice.payment_intent'],
          metadata: { appUserId: userId } // Adicionando metadata na assinatura
      });
      
      const latestInvoice = subscription.latest_invoice as Stripe.Invoice;
      const paymentIntent = (latestInvoice as any).payment_intent as Stripe.PaymentIntent;

      if (!paymentIntent?.client_secret) {
          return res.status(500).send({ error: 'Falha ao criar a intenção de pagamento.' });
      }

      res.json({
        paymentIntent: paymentIntent.client_secret,
        ephemeralKey: ephemeralKey.secret,
        customer: stripeCustomerId,
        subscriptionId: subscription.id
      });

    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      console.error('Erro em /api/create-payment-intent:', message);
      res.status(500).send({ error: `Erro do Stripe: ${message}` });
    }
  });

  // Endpoint 2: Para a Aplicação Web (Stripe Checkout)
  app.post('/api/create-checkout-session', verifyFirebaseToken, async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const userId = user.uid;
    const userEmail = user.email;

    try {
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
       // let stripeCustomerId = userDoc.data()?.stripeCustomerId;
       // if (!stripeCustomerId) {
          const customer = await stripe.customers.create({
            email: userEmail,
            metadata: { appUserId: userId },
          });
          let stripeCustomerId = customer.id;
          await userRef.set({ stripeCustomerId }, { merge: true });
        //}

        const  product = await stripe.products.retrieve("prod_T2g72a1HZ3Qzhs", {
          expand: ['default_price'],
        }, { apiVersion: '2025-09-30.clover' });
      
        console.log(`🔔 stripeCustomerId: ${stripeCustomerId}`);
        console.log(`🔔 product: ${JSON.stringify(product)}`);

        const defaultPrice = product.default_price as Stripe.Price;

      const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        payment_method_types: ['card','boleto'],
        mode: 'subscription',
        line_items: [
          {
            price: `${defaultPrice.id}`,
            quantity: 1
          }
        ],
        success_url: successUrl, 
        cancel_url: cancelUrl,
        metadata: { userId } // Conforme solicitado no TODO
      });
      
      //console.log(`🔔 Sessão de checkout criada para o usuário: ${userId}`);

      if (session.url) {
        res.json({ url: session.url }); 
      } else {
        res.status(500).send({ error: 'Falha ao criar a sessão de checkout do Stripe' });
      }
    } catch (e) {
      console.log('❌ Erro em /api/create-checkout-session:', e);
      const message = e instanceof Error ? e.message : 'Unknown error';
      console.error('Erro em /api/create-checkout-session:', message);
      res.status(500).send({ error: `Erro do Stripe: ${message}` });
    }
  });

  app.listen(port, () => {
    console.log(`[server]: O servidor está rodando em http://localhost:${port}`);
  });

} catch (error) {
  console.error("❌ Erro fatal na inicialização:", error);
  process.exit(1);
}