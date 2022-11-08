import { v4 as uuidv4 } from 'uuid';
import express, { Router } from 'express';
import session from 'express-session';
import grant from 'grant';

import { sendError } from '@/errors';
import {
  ENV,
  generateRedirectUrl,
  getNewRefreshToken,
  getUserByEmail,
  gqlSdk,
  insertUser,
} from '@/utils';
import {
  queryValidator,
  redirectTo as redirectToRule,
  registrationOptions,
} from '@/validation';
import { SessionStore } from './session-store';
import { config, OAUTH_ROUTE, SESSION_NAME } from './config';
import { logger } from '@/logger';
import { InsertUserMutation } from '@/utils/__generated__/graphql-request';
import {
  normaliseProfile,
  preRequestProviderMiddleware,
  transformOauthProfile,
} from './utils';

// TODO handle the provider id, access token, and refresh token. See utils.ts and Grant doc

export const oauthProviders = Router()
  // * Use a middleware to keep the session between Oauth requests
  .use(
    session({
      secret: 'grant',
      resave: false,
      saveUninitialized: true,
      store: new SessionStore(),
      genid: () => uuidv4(),
      name: SESSION_NAME,
    })
  )

  .use(OAUTH_ROUTE, express.urlencoded({ extended: true }))

  // * Determine the redirect url, and store it in the locals so it is available in next middlewares
  .use(`${OAUTH_ROUTE}/:provider`, ({ query }, { locals }, next) => {
    locals.redirectTo = redirectToRule.validate(query, {
      convert: true,
      allowUnknown: true,
    }).value;
    next();
  })

  // * Validate the provider configuration
  .use(`${OAUTH_ROUTE}/:provider`, ({ params: { provider } }, res, next) => {
    const redirectTo: string = res.locals.redirectTo;
    const providerConfig = config[provider];
    // * Check if provider is enabled
    if (!providerConfig) {
      return sendError(res, 'disabled-endpoint', { redirectTo }, true);
    }
    // * Check if the provider has a client id and secret
    if (!providerConfig.client_id || !providerConfig.client_secret) {
      logger.warn(`Missing client id or secret for provider ${provider}`);
      return sendError(
        res,
        'invalid-oauth-configuration',
        { redirectTo },
        true
      );
    }
    next();
  })

  // * Validate registration options from the query parameters, but don't override them with defaults as we'll need them in the callback
  .use(`${OAUTH_ROUTE}/:provider`, queryValidator(registrationOptions, false))

  /**
   * Optional provider-specific middleware
   * @see {@link file://./config/middlewares.ts}
   * */
  .use(`${OAUTH_ROUTE}/:provider`, preRequestProviderMiddleware)

  // * Save the initial query and the redirection url into the session to be able to retrieve them in the callback
  .use(
    `${OAUTH_ROUTE}/:provider`,
    ({ session, query }, { locals: { redirectTo } }, next) => {
      session.options = query;
      session.redirectTo = redirectTo;
      session.save(next);
    }
  )

  /**
   * Grant middleware: handle the oauth flow until the callback
   * @see {@link file://./config/grant.ts}
   */
  .use(grant.express()(config))

  /**
   * Oauth Callback
   * 1. Destroy the Oauth session (we don't need it anymore)
   * 2. Transform the profile to a standard format
   *    @see {@link file://./profiles.ts}
   * 3. Find/create the user in the database
   * 4. Connect the user to the provider
   * 5. Generate and return a new refresh token
   */
  .use(async ({ session }, res) => {
    const { grant, options, redirectTo = ENV.AUTH_CLIENT_URL } = { ...session };
    // * Destroy the session as it is only needed for the oauth flow
    await new Promise((resolve) => {
      session.destroy(() => {
        // * Delete the cookie manually
        // See  https://stackoverflow.com/questions/70101660/how-to-destroy-session
        res.clearCookie(SESSION_NAME);
        return resolve(null);
      });
    });

    const response = grant?.response;
    const provider = grant?.provider;
    if (!response || !provider) {
      return sendError(res, 'internal-error', { redirectTo }, true);
    }
    if (!response.profile) {
      logger.warn('No Oauth profile in the session');
      return sendError(res, 'internal-error', { redirectTo }, true);
    }
    const profile = await normaliseProfile(provider, response);

    const providerUserId = profile.id;

    const {
      access_token: accessToken,
      refresh_token: refreshToken,
      jwt,
    } = response;
    console.log('From the prodiver:', { accessToken, refreshToken, jwt });

    let user: NonNullable<InsertUserMutation['insertUser']> | null = null;

    // * Look for the user-provider
    const {
      authUserProviders: [authUserProvider],
    } = await gqlSdk.authUserProviders({
      provider,
      providerUserId,
    });

    if (authUserProvider) {
      // * The userProvider already exists. Update it with the new tokens
      user = authUserProvider.user;
      await gqlSdk.updateAuthUserprovider({
        id: authUserProvider.id,
        authUserProvider: {
          accessToken,
          refreshToken,
        },
      });
    } else {
      user = await getUserByEmail(profile.email);
      if (user) {
        // * add this provider to existing user with the same email
        const { insertAuthUserProvider } =
          await gqlSdk.insertUserProviderToUser({
            userProvider: {
              userId: user.id,
              providerId: provider,
              providerUserId,
              accessToken,
              refreshToken,
            },
          });

        if (!insertAuthUserProvider) {
          console.warn('Could not add a provider to user');
          return sendError(res, 'internal-error', { redirectTo }, true);
        }
      } else {
        // * No user found with this emaail. Create a new user
        // TODO do we always allow registration?
        const userInput = await transformOauthProfile(profile, options);
        user = await insertUser({
          ...userInput,
          userProviders: {
            data: [
              {
                providerId: provider,
                providerUserId,
                accessToken,
                refreshToken,
              },
            ],
          },
        });
      }
    }

    if (user) {
      const refreshToken = await getNewRefreshToken(user.id);
      // * redirect back user to app url
      return res.redirect(`${redirectTo}?refreshToken=${refreshToken}`);
    }
    // TODO capture provider errors / cancellations
    return res.redirect(
      generateRedirectUrl(redirectTo, {
        error: 'error' || 'invalid-request',
        provider,
        errorDescription: 'error_description' || 'OAuth request cancelled',
      })
    );
  });

// http://localhost:4000/signin/provider/workos
// http://localhost:4000/signin/provider/google
// http://localhost:4000/signin/provider/github
// http://localhost:4000/signin/provider/facebook
