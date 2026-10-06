import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
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
import { pairPage, pairScript } from './pair-page.js';

const phonePattern = '^\\+[1-9][0-9]{6,14}$';
const messageSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 1000,
  pattern: '\\S',
};
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
    loggerInstance: logger as FastifyBaseLogger | undefined,
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
  // Reuse one limiter so URL and POST sends share the same sender budget.
  const senderRateLimit = app.rateLimit({
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    keyGenerator: () => 'sender',
  });
  async function submitOtp(
    requestId: string,
    input: { phone: string; otp: string },
  ) {
    return submitMessage(requestId, {
      phone: input.phone,
      message: config.messageTemplate.replace('{otp}', input.otp),
    });
  }
  async function submitMessage(
    requestId: string,
    input: { phone: string; message: string },
  ) {
    const messageId = await gateway.send(input.phone, input.message);
    return { status: 'submitted', messageId, requestId };
  }
  app.setNotFoundHandler((_request, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }),
  );
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
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
            request.routeOptions.url === '/admin/reset'
              ? 'Reset requires the explicit confirmation RESET_WHATSAPP_SESSION.'
              : request.routeOptions.url === '/send-message'
                ? 'Provide a phone in international +countrycode format and a non-blank message of 1-1000 characters, without extra fields.'
                : 'Provide a phone in international +countrycode format and an OTP string of 4-10 digits, without extra fields.',
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
  app.get('/pair', async (_request, reply) =>
    reply
      .header(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      )
      .header('X-Frame-Options', 'DENY')
      .header('X-Robots-Tag', 'noindex, nofollow, noarchive')
      .type('text/html; charset=utf-8')
      .send(pairPage),
  );
  app.get('/pair/app.js', async (_request, reply) =>
    reply.type('text/javascript; charset=utf-8').send(pairScript),
  );

  // Optional URL credential is separate from sending/admin bearer credentials.
  if (config.urlSendKey) {
    const expected = createHash('sha256').update(config.urlSendKey).digest();
    const urlAuth = async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
      const key = (request.query as { key?: unknown }).key;
      const actual = createHash('sha256')
        .update(typeof key === 'string' ? key : '')
        .digest();
      if (!timingSafeEqual(expected, actual)) {
        return reply.code(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'A valid URL key is required.',
          },
        });
      }
      const purpose = `${request.headers.purpose ?? ''} ${request.headers['sec-purpose'] ?? ''}`;
      if (purpose.toLowerCase().includes('prefetch')) {
        return reply.code(425).send({
          error: {
            code: 'PREFETCH_REJECTED',
            message: 'Prefetch requests cannot send messages.',
          },
        });
      }
    };
    app.get<{ Querystring: { key: string; phone: string; otp: string } }>(
      '/send-otp',
      {
        // A browser's HEAD probe must never submit a message.
        exposeHeadRoute: false,
        onRequest: urlAuth,
        preHandler: senderRateLimit,
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'phone', 'otp'],
            properties: {
              key: { type: 'string', minLength: 32, maxLength: 256 },
              phone: { type: 'string', pattern: phonePattern },
              otp: { type: 'string', pattern: '^[0-9]{4,10}$' },
            },
          },
        },
      },
      async (request) => submitOtp(request.id, request.query),
    );
    app.get<{ Querystring: { key: string; phone: string; message: string } }>(
      '/send-message',
      {
        exposeHeadRoute: false,
        onRequest: urlAuth,
        preHandler: senderRateLimit,
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'phone', 'message'],
            properties: {
              key: { type: 'string', minLength: 32, maxLength: 256 },
              phone: { type: 'string', pattern: phonePattern },
              message: messageSchema,
            },
          },
        },
      },
      async (request) => submitMessage(request.id, request.query),
    );
  }

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
        preHandler: senderRateLimit,
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
      async (request) => submitOtp(request.id, request.body),
    );
    api.post<{ Body: { phone: string; message: string } }>(
      '/send-message',
      {
        // Allow 1,000 Unicode characters including JSON escape overhead.
        bodyLimit: 16384,
        preHandler: senderRateLimit,
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['phone', 'message'],
            properties: {
              phone: { type: 'string', pattern: phonePattern },
              message: messageSchema,
            },
          },
        },
      },
      async (request) => submitMessage(request.id, request.body),
    );
  });

  await app.register(
    async (admin) => {
      admin.addHook('onRequest', bearerAuth(config.adminKey));
      admin.get('/session', async () => gateway.status());
      admin.post<{ Body: { confirm: 'RESET_WHATSAPP_SESSION' } }>(
        '/reset',
        {
          config: {
            rateLimit: {
              max: 2,
              timeWindow: '1 minute',
              keyGenerator: () => 'session-reset',
            },
          },
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['confirm'],
              properties: {
                confirm: { type: 'string', enum: ['RESET_WHATSAPP_SESSION'] },
              },
            },
          },
          preHandler: async (request, reply) => {
            // Browser resets must originate on this host and use bearer auth.
            if (request.headers.origin) {
              let sameHost = false;
              try {
                sameHost =
                  new URL(request.headers.origin).host === request.headers.host;
              } catch {}
              if (!sameHost)
                return reply.code(403).send({
                  error: {
                    code: 'ORIGIN_REJECTED',
                    message:
                      'Reset must be requested from the pairing page on this host.',
                  },
                });
            }
          },
        },
        async () => gateway.resetSession(),
      );
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
