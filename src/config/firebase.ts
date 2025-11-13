import * as admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

try {
  const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountString) {
    throw new Error("A variável de ambiente FIREBASE_SERVICE_ACCOUNT_JSON é necessária.");
  }
  const serviceAccount = JSON.parse(serviceAccountString);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('✅ Firebase Admin SDK inicializado com sucesso.');
} catch (error) {
  console.error("❌ Erro fatal na inicialização do Firebase:", error);
  process.exit(1);
}

export const db = admin.firestore();
export const auth = admin.auth();
