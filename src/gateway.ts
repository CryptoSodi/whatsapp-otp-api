export type SessionState =
  | 'connecting'
  | 'awaiting_pairing'
  | 'connected'
  | 'reconnecting'
  | 'logged_out'
  | 'error'
  | 'stopped';

export interface WhatsAppGateway {
  status(): { state: SessionState };
  qr(): string | undefined;
  pairingCode(phone: string): Promise<string>;
  send(phone: string, text: string): Promise<string>;
}
