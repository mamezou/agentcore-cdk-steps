import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession
} from 'amazon-cognito-identity-js';

// These will be set from environment variables after deployment
const COGNITO_CONFIG = {
  UserPoolId: import.meta.env.VITE_USER_POOL_ID || '',
  ClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID || ''
};

let userPool: CognitoUserPool | null = null;

function getUserPool(): CognitoUserPool {
  if (!userPool && COGNITO_CONFIG.UserPoolId && COGNITO_CONFIG.ClientId) {
    userPool = new CognitoUserPool(COGNITO_CONFIG);
  }
  if (!userPool) {
    throw new Error('Cognito not configured. Set VITE_USER_POOL_ID and VITE_USER_POOL_CLIENT_ID');
  }
  return userPool;
}

export interface AuthUser {
  email: string;
  accessToken: string;
  idToken: string;
}

export async function signIn(email: string, password: string): Promise<AuthUser> {
  return new Promise((resolve, reject) => {
    const pool = getUserPool();
    const user = new CognitoUser({ Username: email, Pool: pool });
    const authDetails = new AuthenticationDetails({ Username: email, Password: password });

    user.authenticateUser(authDetails, {
      onSuccess: (session: CognitoUserSession) => {
        resolve({
          email,
          accessToken: session.getAccessToken().getJwtToken(),
          idToken: session.getIdToken().getJwtToken()
        });
      },
      onFailure: (err) => {
        reject(err);
      },
      newPasswordRequired: () => {
        reject(new Error('NEW_PASSWORD_REQUIRED'));
      }
    });
  });
}

export async function signOut(): Promise<void> {
  const pool = getUserPool();
  const user = pool.getCurrentUser();
  if (user) {
    user.signOut();
  }
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  return new Promise((resolve) => {
    try {
      const pool = getUserPool();
      const user = pool.getCurrentUser();

      if (!user) {
        resolve(null);
        return;
      }

      user.getSession((err: Error | null, session: CognitoUserSession | null) => {
        if (err || !session || !session.isValid()) {
          resolve(null);
          return;
        }

        user.getUserAttributes((_err, attributes) => {
          const email = attributes?.find(a => a.Name === 'email')?.Value || '';
          resolve({
            email,
            accessToken: session.getAccessToken().getJwtToken(),
            idToken: session.getIdToken().getJwtToken()
          });
        });
      });
    } catch {
      resolve(null);
    }
  });
}

export function isConfigured(): boolean {
  return Boolean(COGNITO_CONFIG.UserPoolId && COGNITO_CONFIG.ClientId);
}
