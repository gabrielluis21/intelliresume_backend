import { Request, Response, NextFunction } from 'express';
import { auth } from '../config/firebase';

// Interface para estender o objeto Request do Express e adicionar a propriedade 'user'
interface AuthenticatedRequest extends Request {
  user?: any;
}

export const verifyFirebaseToken = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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
