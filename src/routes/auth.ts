import { Router, Request, Response, NextFunction } from 'express';
import { Session } from 'express-session';
import passport from '../config/passport';

const router = Router();

// Extends the Express session object to include our custom redirectUrl
interface CustomSession extends Session {
  redirectUrl?: string;
}

// Step 1: The user is sent to this route from the frontend.
// We save the final redirect URL in the session and start the passport flow.
router.get('/linkedin', (req: Request, res: Response, next: NextFunction) => {
  const session = req.session as CustomSession;
  const redirectUrl = req.query.redirect_url as string;

  // Store the final frontend redirect URL in the session.
  // This will be used in the callback after LinkedIn authentication.
  session.redirectUrl = redirectUrl || '/';

  // Start the LinkedIn authentication flow.
  passport.authenticate('linkedin', { state: 'SOME_STATE' })(req, res, next);
});

// Step 2: LinkedIn redirects the user back to this route.
// Passport.js middleware authenticates the user.
// If successful, our custom handler is executed.
router.get(
  '/linkedin/callback',
  passport.authenticate('linkedin', {
    failureRedirect: '/login', // Or a more specific error page
  }),
  (req: Request, res: Response) => {
    // The user is now authenticated, and `req.user` is populated by Passport.
    // The `req.user` object contains the custom Firebase token we created.
    const user = req.user as any;
    const token = user.customToken;

    const session = req.session as CustomSession;
    const redirectUrl = session.redirectUrl;

    // Clean up the session
    delete session.redirectUrl;

    if (!token) {
      // Handle error: for some reason, the token wasn't generated.
      return res.redirect('/login?error=auth_failed');
    }

    // Redirect the user back to the original frontend URL,
    // appending the custom token so the frontend can sign in.
    const finalUrl = new URL(redirectUrl!);
    finalUrl.searchParams.append('token', token);

    res.redirect(finalUrl.toString());
  },
);

export default router;
