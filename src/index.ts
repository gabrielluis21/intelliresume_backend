import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import session from 'express-session';
import passport from './config/passport';
import authRoutes from './routes/auth';
import paymentRoutes from './routes/payment'; // 1. Importa as novas rotas
import { db } from './config/firebase';
import { verifyFirebaseToken } from './middlewares/auth';

dotenv.config();

try {
  const stripeApiKey = process.env.STRIPE_SECRET_KEY;
  const backendUrl = process.env.BACKEND_URL;

  if (!stripeApiKey || !backendUrl) {
    throw new Error("As variáveis de ambiente STRIPE_SECRET_KEY e BACKEND_URL devem ser definidas.");
  }

  const stripe = new Stripe(stripeApiKey, {
    apiVersion: '2025-10-29.clover',
    typescript: true,
  });
  console.log('✅ Stripe SDK inicializado com sucesso.');

  const app = express();
  const port = process.env.PORT || 3000;

  const whitelist = [
    'http://localhost:3000',
    'http://localhost:8080',
    'https://gabrielluis21.github.io'
  ];
  const corsOptions = {
    origin: (origin: any, callback: any) => {
      if (whitelist.some(allowedOrigin => origin && origin.startsWith(allowedOrigin)) || !origin) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    optionsSuccessStatus: 200
  };

  app.use(cors(corsOptions));

  // 2. Usa o paymentRoutes ANTES do express.json() por causa do webhook
  app.use('/api/payment', paymentRoutes);
  
  app.use(express.json());
  app.use(session({
    secret: process.env.SESSION_SECRET || 'supersecret',
    resave: false,
    saveUninitialized: false
  }));
  app.use(passport.initialize());
  app.use(passport.session());

  app.use('/auth', authRoutes);

  // 3. Lógica de webhook e verifyFirebaseToken foram REMOVIDAS daqui

  app.get('/', (req: Request, res: Response) => {
    res.send('IntelliResume Backend is running!');
  });

  // Endpoint para o App Mobile (PaymentSheet)
  app.post('/api/create-payment-intent', verifyFirebaseToken, async (req: Request, res: Response) => {
    const { priceId } = req.body; // 4. Recebe o priceId do frontend
    const user = (req as any).user;
    
    if (!priceId) {
      return res.status(400).send({ error: 'O priceId é obrigatório.' });
    }

    try {
      const userRef = db.collection('users').doc(user.uid);
      const userDoc = await userRef.get();
      let stripeCustomerId = userDoc.data()?.stripeCustomerId;

      if (!stripeCustomerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { userId: user.uid },
        });
        stripeCustomerId = customer.id;
        await userRef.set({ stripeCustomerId }, { merge: true });
      }

      const ephemeralKey = await stripe.ephemeralKeys.create(
        { customer: stripeCustomerId },
        { apiVersion: '2024-04-10' }
      );

      const subscription = await stripe.subscriptions.create({
          customer: stripeCustomerId,
          items: [{ price: priceId }], // Usa o priceId do frontend
          payment_behavior: 'default_incomplete',
          payment_settings: { save_default_payment_method: 'on_subscription' },
          expand: ['latest_invoice.payment_intent'],
          metadata: { userId: user.uid } // Salva o userId para o webhook
      });
      
      const latestInvoice = subscription.latest_invoice;
      const paymentIntent = (latestInvoice as any)?.payment_intent;

      if (!paymentIntent || typeof paymentIntent === 'string' || !paymentIntent.client_secret) {
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
      res.status(500).send({ error: `Erro do Stripe: ${message}` });
    }
  });

  // Endpoint para a Aplicação Web (Stripe Checkout)
  app.post('/api/create-checkout-session', verifyFirebaseToken, async (req: Request, res: Response) => {
    const { priceId } = req.body; // 5. Recebe o priceId do frontend
    const user = (req as any).user;

    if (!priceId) {
      return res.status(400).send({ error: 'O priceId é obrigatório.' });
    }

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card', 'boleto'],
        mode: 'subscription',
        line_items: [{
          price: priceId, // Usa o priceId do frontend
          quantity: 1
        }],
        // 6. Aponta para as novas rotas de backend
        success_url: `${backendUrl}/api/payment/success`, 
        cancel_url: `${backendUrl}/api/payment/cancel`,
        metadata: { 
          userId: user.uid // Salva o userId para o webhook
        }
      });

      if (session.url) {
        res.json({ url: session.url }); 
      } else {
        res.status(500).send({ error: 'Falha ao criar a sessão de checkout do Stripe' });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
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