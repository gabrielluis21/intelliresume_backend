# Requisitos do Backend para Pagamentos (IntelliResume)

*Última atualização: 2025-10-07*

Este documento detalha os endpoints de API necessários no backend (Node.js/Vercel) para suportar os fluxos de pagamento do IntelliResume, tanto para a versão mobile (via PaymentSheet) quanto para a web (via Stripe Checkout).

## 1. Variáveis de Ambiente Necessárias

O backend precisará das seguintes variáveis de ambiente configuradas:

- `STRIPE_SECRET_KEY`: Chave secreta da sua conta Stripe.
- `STRIPE_WEBHOOK_SECRET`: Segredo do endpoint do webhook, gerado no painel do Stripe.
- `SUCCESS_URL`: URL para a qual o usuário será redirecionado após um pagamento bem-sucedido na web (ex: `https://meu-app.com/sucesso`).
- `CANCEL_URL`: URL para a qual o usuário será redirecionado se cancelar o pagamento na web (ex: `https://meu-app.com/cancelou`).
- `FIREBASE_SERVICE_ACCOUNT_JSON`: As credenciais da conta de serviço do Firebase (em formato JSON) para usar o Firebase Admin SDK.

---

## 2. Endpoints da API

### Endpoint 1: Para o App Mobile (PaymentSheet)

- **Endpoint:** `POST /api/create-payment-intent`
- **Propósito:** Fornecer os segredos necessários para o `PaymentSheet` nativo do Flutter.
- **Autenticação:** O frontend enviará o token de ID do Firebase no cabeçalho `Authorization: Bearer <token>`. O endpoint deve verificar este token.
- **Lógica:**
  1.  Verificar o token do Firebase para autenticar o usuário.
  2.  Buscar ou criar um `Customer` no Stripe usando o e-mail do usuário.
  3.  Criar uma `Ephemeral Key` para esse `Customer`.
  4.  Criar um `PaymentIntent` com o valor, moeda (ex: `BRL`) e o ID do `Customer`.
- **Resposta de Sucesso (200 OK):**
  ```json
  {
    "paymentIntent": "pi_...",
    "ephemeralKey": "ek_...",
    "customer": "cus_..."
  }
  ```
- **Resposta de Erro (4xx/5xx):**
  ```json
  {
    "error": "Mensagem de erro descritiva."
  }
  ```

### Endpoint 2: Para a Aplicação Web (Stripe Checkout)

- **Endpoint:** `POST /api/create-checkout-session`
- **Propósito:** Criar uma sessão de checkout e redirecionar o usuário para a página de pagamento hospedada pelo Stripe.
- **Autenticação:** Idêntica ao endpoint 1 (via token do Firebase).
- **Lógica:**
  1.  Verificar o token do Firebase.
  2.  Buscar ou criar um `Customer` no Stripe.
  3.  Criar uma `Checkout.Session`, especificando:
      - O ID do `Customer`.
      - `line_items`: O produto/plano que está sendo comprado.
      - `mode`: `payment` ou `subscription`.
      - `success_url`: A URL de sucesso (lida das variáveis de ambiente).
      - `cancel_url`: A URL de cancelamento (lida das variáveis de ambiente).
      - **Importante:** Adicionar o `userId` do Firebase na `metadata` da sessão para uso no webhook (`metadata: { userId: user.uid }`).
- **Resposta de Sucesso (200 OK):**
  ```json
  {
    "url": "https://checkout.stripe.com/..."
  }
  ```
- **Resposta de Erro (4xx/5xx):**
  ```json
  {
    "error": "Mensagem de erro descritiva."
  }
  ```

### Endpoint 3: Webhook de Confirmação

- **Endpoint:** `POST /api/stripe-webhook`
- **Propósito:** Receber eventos do Stripe de forma segura para confirmar transações e atualizar o status do usuário no banco de dados.
- **Segurança:** Este endpoint é público, mas deve ser protegido pela verificação da assinatura do webhook.
- **Lógica:**
  1.  **Verificar a assinatura do webhook** usando o `STRIPE_WEBHOOK_SECRET`. Rejeitar qualquer requisição que não passe na verificação.
  2.  Analisar o evento recebido. Os eventos mais importantes são:
      - `checkout.session.completed`: Confirmação de um pagamento via web.
      - `payment_intent.succeeded`: Confirmação de um pagamento via mobile.
  3.  Extrair o `userId` da `metadata` do objeto do evento.
  4.  Inicializar o **Firebase Admin SDK** com as credenciais da conta de serviço.
  5.  Usar o Admin SDK para se conectar ao Firestore e atualizar o documento do usuário correspondente (ex: `db.collection('users').doc(userId).update({ 'plan': 'premium' })`).
- **Resposta de Sucesso (200 OK):**
  - Retornar um status `200` com um JSON `{ "received": true }` para confirmar ao Stripe que o evento foi recebido com sucesso. Se o Stripe não receber uma resposta 200, ele continuará tentando enviar o evento.
