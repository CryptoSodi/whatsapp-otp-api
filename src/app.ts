import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, {
  LogController,
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import QRCode from 'qrcode';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { WhatsAppGateway } from './gateway.js';
import { ApiError } from './errors.js';

const phonePattern = '^\\+[1-9][0-9]{6,14}$';
function bearerAuth(secret: string) {
  const expected = createHash('sha256').update(secret).digest();
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const actual = createHash('sha256').update(supplied).digest();
    if (!timingSafeEqual(expected, actual)) {
      reply.header('WWW-Authenticate', 'Bearer');
      return reply.code(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'A valid bearer token is required.',
        },
      });
    }
  };
}

export async function buildApp(
  config: Config,
  gateway: WhatsAppGateway,
  logger?: Logger,
) {
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2048,
    requestTimeout: 30000,
    trustProxy: false,
    // Preserve OTPs as strings; reject extra fields instead of silently stripping them.
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        useDefaults: false,
      },
    },
  });
  await app.register(rateLimit, { global: false, hook: 'preHandler' });
  app.setNotFoundHandler((_request, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }),
  );
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  });
  app.addHook('onResponse', async (request, reply) => {
    // Never log raw URLs, authorization headers, request bodies or provider errors.
    app.log.info(
      {
        requestId: request.id,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
      },
      'Request completed',
    );
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
        requestId: request.id,
      });
    }
    if (error.statusCode === 429) {
      return reply.code(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Wait before retrying.',
        },
        requestId: request.id,
      });
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: {
          code: 'INVALID_REQUEST',
          message:
            'Provide a JSON body with a phone in international +countrycode format and an OTP string of 4-10 digits.',
        },
        requestId: request.id,
      });
    }
    app.log.error({ requestId: request.id }, 'Unhandled request error');
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.',
      },
      requestId: request.id,
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(async (api) => {
    api.addHook('onRequest', bearerAuth(config.apiKey));
    api.get('/ready', async (_request, reply) => {
      const { state } = gateway.status();
      return reply
        .code(state === 'connected' ? 200 : 503)
        .send({ ready: state === 'connected' });
    });
    api.post<{ Body: { phone: string; otp: string } }>(
      '/send-otp',
      {
        config: {
          rateLimit: {
            max: config.rateLimitMax,
            timeWindow: '1 minute',
            keyGenerator: () => 'sender',
          },
        },
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['phone', 'otp'],
            properties: {
              phone: { type: 'string', pattern: phonePattern },
              otp: { type: 'string', pattern: '^[0-9]{4,10}$' },
            },
          },
        },
      },
      async (request) => {
        const messageId = await gateway.send(
          request.body.phone,
          config.messageTemplate.replace('{otp}', request.body.otp),
        );
        return { status: 'submitted', messageId, requestId: request.id };
      },
    );
  });

  await app.register(
    async (admin) => {
      admin.addHook('onRequest', bearerAuth(config.adminKey));
      admin.get('/session', async () => gateway.status());
      admin.get(
        '/qr',
        {
          config: {
            rateLimit: {
              max: 30,
              timeWindow: '1 minute',
              keyGenerator: () => 'qr',
            },
          },
        },
        async (_request, reply) => {
          const qr = gateway.qr();
          if (!qr)
            throw new ApiError(
              409,
              'QR_UNAVAILABLE',
              'No active QR code. Check /admin/session and try again when awaiting_pairing.',
            );
          reply.header(
            'Content-Security-Policy',
            "default-src 'none'; sandbox",
          );
          return reply.type('image/svg+xml').send(
            await QRCode.toString(qr, {
              type: 'svg',
              errorCorrectionLevel: 'L',
            }),
          );
        },
      );
      admin.post<{ Body: { phone: string } }>(
        '/pairing-code',
        {
          config: {
            rateLimit: {
              max: 2,
              timeWindow: '1 minute',
              keyGenerator: () => 'pairing',
            },
          },
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['phone'],
              properties: { phone: { type: 'string', pattern: phonePattern } },
            },
          },
        },
        async (request) => ({
          code: await gateway.pairingCode(request.body.phone),
        }),
      );
    },
    { prefix: '/admin' },
  );

  return app;
}
