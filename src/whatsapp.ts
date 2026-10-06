import makeWASocket, {
  Browsers,
  DisconnectReason,
  type ConnectionState,
  type UserFacingSocketConfig,
} from '@whiskeysockets/baileys';
import { pino, type Logger } from 'pino';
import type { Config } from './config.js';
import type { openAuthStore } from './auth-store.js';
import type { SessionState, WhatsAppGateway } from './gateway.js';
import { ApiError } from './errors.js';

export type Socket = Pick<
  ReturnType<typeof makeWASocket>,
  'ev' | 'end' | 'onWhatsApp' | 'sendMessage' | 'requestPairingCode'
>;
type SocketFactory = (options: UserFacingSocketConfig) => Socket;
type AuthStore = ReturnType<typeof openAuthStore>;

export class WhatsAppClient implements WhatsAppGateway {
  private socket?: Socket;
  private state: SessionState = 'stopped';
  private qrValue?: string;
  private reconnectTimer?: NodeJS.Timeout;
  private attempts = 0;
  private stopped = true;
  private sending = false;
  private pairing = false;

  constructor(
    private readonly config: Pick<Config, 'sendTimeoutMs'>,
    private readonly auth: AuthStore,
    private readonly logger: Logger,
    private readonly onFatal: () => void,
    private readonly factory: SocketFactory = makeWASocket,
  ) {}

  status() {
    return { state: this.state };
  }
  qr() {
    return this.state === 'awaiting_pairing' ? this.qrValue : undefined;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    this.state = 'connecting';
    try {
      const socket = this.factory({
        auth: this.auth.state,
        // Library logs may include encryption material and message contents.
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 20000,
        defaultQueryTimeoutMs: this.config.sendTimeoutMs,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        // Keep the library's initial sync: v7 needs it for recipient LID mappings.
        // No history/message event is stored or exposed by this application.
        // The caller owns expiry and retry decisions. Do not replay old OTPs.
        enableRecentMessageCache: false,
        enableAutoSessionRecreation: false,
        getMessage: async () => undefined,
      });
      this.socket = socket;
      socket.ev.on('creds.update', () => {
        if (this.socket !== socket) return;
        try {
          this.auth.saveCreds();
        } catch {
          this.logger.error('Cannot persist WhatsApp credentials; stopping');
          this.onFatal();
        }
      });
      socket.ev.on('connection.update', (update) =>
        this.onConnection(socket, update),
      );
    } catch {
      this.logger.warn('WhatsApp connection could not start');
      this.scheduleReconnect();
    }
  }

  private onConnection(socket: Socket, update: Partial<ConnectionState>) {
    if (socket !== this.socket || this.stopped) return;
    if (update.qr) {
      this.qrValue = update.qr;
      this.state = 'awaiting_pairing';
      this.logger.info(
        'WhatsApp pairing is required; use the admin QR or pairing-code endpoint',
      );
    }
    if (update.connection === 'open') {
      this.state = 'connected';
      this.qrValue = undefined;
      this.attempts = 0;
      this.logger.info('WhatsApp connected');
    }
    if (update.connection === 'close') {
      this.socket = undefined;
      this.qrValue = undefined;
      const reason = (
        update.lastDisconnect?.error as
          { output?: { statusCode?: number } } | undefined
      )?.output?.statusCode;
      const terminal = [
        DisconnectReason.loggedOut,
        DisconnectReason.badSession,
        DisconnectReason.connectionReplaced,
        DisconnectReason.forbidden,
        DisconnectReason.multideviceMismatch,
      ];
      if (reason !== undefined && terminal.includes(reason)) {
        this.state =
          reason === DisconnectReason.loggedOut ? 'logged_out' : 'error';
        this.logger.error(
          { reason },
          'WhatsApp needs operator attention; automatic reconnection stopped',
        );
      } else {
        this.scheduleReconnect(reason === DisconnectReason.restartRequired);
      }
    }
  }

  private scheduleReconnect(immediate = false) {
    if (this.stopped || this.reconnectTimer) return;
    this.state = 'reconnecting';
    const delay = immediate
      ? 250
      : Math.min(1000 * 2 ** Math.min(this.attempts++, 5), 30000) +
        Math.floor(Math.random() * 500);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private async withDeadline<T>(
    socket: Socket,
    operation: (expired: () => boolean) => Promise<T>,
  ): Promise<T> {
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(() => expired),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            expired = true;
            // Invalidate the socket before reconnecting; a late lookup must not send.
            if (this.socket === socket) {
              this.socket = undefined;
              this.qrValue = undefined;
              void socket
                .end(new Error('Operation timeout'))
                .catch(() => undefined);
              this.scheduleReconnect();
            }
            reject(
              new ApiError(
                504,
                'SEND_UNCONFIRMED',
                'WhatsApp timed out. The message may have been sent; do not retry automatically.',
              ),
            );
          }, this.config.sendTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async send(phone: string, text: string): Promise<string> {
    const socket = this.socket;
    if (!socket || this.state !== 'connected') {
      throw new ApiError(
        503,
        'WHATSAPP_UNAVAILABLE',
        'WhatsApp is not connected. No message was submitted.',
      );
    }
    if (this.sending)
      throw new ApiError(
        429,
        'SENDER_BUSY',
        'Another message is being submitted. No message was submitted for this request.',
      );
    this.sending = true;
    try {
      return await this.withDeadline(socket, async (expired) => {
        try {
          const recipients = await socket.onWhatsApp(phone.slice(1));
          if (
            expired() ||
            this.socket !== socket ||
            this.state !== 'connected'
          ) {
            throw new ApiError(
              503,
              'WHATSAPP_UNAVAILABLE',
              'WhatsApp disconnected before sending. No message was submitted.',
            );
          }
          const recipient = recipients?.[0];
          if (!recipient)
            throw new ApiError(
              502,
              'LOOKUP_FAILED',
              'WhatsApp recipient lookup failed. No message was submitted.',
            );
          if (!recipient.exists)
            throw new ApiError(
              422,
              'NOT_ON_WHATSAPP',
              'The supplied phone number is not registered on WhatsApp.',
            );
          const message = await socket.sendMessage(recipient.jid, { text });
          if (!message?.key.id) throw new Error('Missing message ID');
          return message.key.id;
        } finally {
          // Keep the guard while an operation is still settling after a timeout.
          this.sending = false;
        }
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.logger.warn('WhatsApp submission failed; delivery is unconfirmed');
      throw new ApiError(
        502,
        'SEND_UNCONFIRMED',
        'WhatsApp could not confirm submission. The message may have been sent; do not retry automatically.',
      );
    }
  }

  async pairingCode(phone: string): Promise<string> {
    const socket = this.socket;
    if (
      !socket ||
      this.state !== 'awaiting_pairing' ||
      this.auth.state.creds.registered
    ) {
      throw new ApiError(
        409,
        'PAIRING_UNAVAILABLE',
        'Wait until /admin/session reports awaiting_pairing.',
      );
    }
    if (this.pairing)
      throw new ApiError(
        409,
        'PAIRING_BUSY',
        'A pairing request is already running.',
      );
    this.pairing = true;
    try {
      return await this.withDeadline(socket, async () => {
        try {
          return await socket.requestPairingCode(phone.slice(1));
        } finally {
          this.pairing = false;
        }
      });
    } catch {
      throw new ApiError(
        502,
        'PAIRING_FAILED',
        'Could not obtain a pairing code. Check session status before retrying.',
      );
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.qrValue = undefined;
    this.state = 'stopped';
    const socket = this.socket;
    if (socket) {
      // end() closes the connection without unlinking the account, unlike logout().
      await socket.end(undefined);
      this.auth.saveCreds();
    }
    this.socket = undefined;
  }
}
