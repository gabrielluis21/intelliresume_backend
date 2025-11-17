import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import { db } from '../config/firebase';
import { verifyFirebaseToken } from '../middlewares/auth';

const router = express.Router();

const stripeApiKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

if (!stripeApiKey || !stripeWebhookSecret) {
  throw new Error("As variáveis de ambiente do Stripe (secret e webhook) devem ser definidas.");
}

const stripe = new Stripe(stripeApiKey, {
  apiVersion: '2024-04-10', // Usando uma versão estável
  typescript: true,
});

const FRONTEND_DASHBOARD_URL = process.env.FRONTEND_URL
  ? `${process.env.FRONTEND_URL}/home`
  : 'http://localhost:3000/home';

// Rota de sucesso para o fluxo web
router.get('/success', (req: Request, res: Response) => {
  res.redirect(`${FRONTEND_DASHBOARD_URL}?payment=success`);
});

// Rota de cancelamento para o fluxo web
router.get('/cancel', verifyFirebaseToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.uid;
    await db.collection('users').doc(userId).update({ plan: 'GRATUITO', isPremium: false });
    console.log(`Usuário ${userId} cancelou o pagamento. Plano definido como GRATUITO.`);
  } catch (error) {
    console.error("Erro ao processar cancelamento de pagamento:", error);
  } finally {
    res.redirect(`${FRONTEND_DASHBOARD_URL}?payment=cancel`);
  }
});

// Webhook para receber todos os eventos do Stripe
router.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) {
    return res.status(400).send('Webhook Error: Signature not found.');
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    const message = `Webhook Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
    return res.status(400).send(message);
  }

  // Lógica principal do webhook
  switch (event.type) {
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = invoice.customer as string;
      // Para assinaturas, o userId está na metadata da assinatura
      if (typeof invoice.subscription === 'string') {
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        const userId = subscription.metadata.userId; // Assumindo que salvamos 'userId'
        if (userId) {
          await db.collection('users').doc(userId).update({ plan: 'PREMIUM', isPremium: true });
          console.log(`Plano do usuário ${userId} atualizado para PREMIUM via assinatura.`);
        }
      }
      break;
    }
    
    case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        // Para pagamentos únicos ou a primeira fatura da assinatura via checkout
        if (session.payment_status === 'paid') {
            const userId = session.metadata?.userId;
            if (userId) {
                await db.collection('users').doc(userId).update({ plan: 'PREMIUM', isPremium: true });
                console.log(`Plano do usuário ${userId} atualizado para PREMIUM via checkout.`);
            }
        }
        break;
    }

    case 'invoice.payment_failed':
    case 'checkout.session.expired': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      if (userId) {
        await db.collection('users').doc(userId).update({ plan: 'GRATUITO', isPremium: false });
        console.log(`Falha/expiração de pagamento para ${userId}. Plano garantido como GRATUITO.`);
      }
      break;
    }

    default:
      console.log(`Webhook não tratado do tipo ${event.type}`);
  }

  res.json({ received: true });
});

export default router;
