import passport from 'passport';
import { Strategy as LinkedInStrategy } from 'passport-linkedin-oauth2';
import dotenv from 'dotenv';
import { auth, db } from './firebase';

dotenv.config();

passport.use(new LinkedInStrategy({
  clientID: process.env.LINKEDIN_KEY!,
  clientSecret: process.env.LINKEDIN_SECRET!,
  callbackURL: process.env.LINKEDIN_CALLBACK_URL!,
  scope: ['r_emailaddress', 'r_liteprofile'],
}, async (accessToken, refreshToken, profile, done) => {
  const email = profile.emails[0].value;
  const name = profile.displayName;
  const photo = profile.photos[0].value;

  try {
    let userRecord = await auth.getUserByEmail(email).catch(() => null);

    if (userRecord) {
      await auth.updateUser(userRecord.uid, {
        displayName: name,
        photoURL: photo,
      });
      await db.collection('users').doc(userRecord.uid).set({
        name,
        email,
        photo,
      }, { merge: true });
    } else {
      userRecord = await auth.createUser({
        email,
        emailVerified: true,
        displayName: name,
        photoURL: photo,
      });
      await db.collection('users').doc(userRecord.uid).set({
        name,
        email,
        photo,
      });
    }
    
    // Generate a custom token for the frontend to sign in
    const customToken = await auth.createCustomToken(userRecord.uid);

    // Pass the user record and the custom token to the next step
    done(null, { ...userRecord.toJSON(), customToken });
  } catch (error) {
    done(error);
  }
}));

passport.serializeUser((user: any, done) => {
  done(null, user.uid);
});

passport.deserializeUser(async (uid: string, done) => {
  try {
    const userRecord = await auth.getUser(uid);
    done(null, userRecord);
  } catch (error) {
    done(error);
  }
});

export default passport;
