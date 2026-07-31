// qrcode-svg ships no type definitions of its own — minimal ambient declaration
// covering only the options/methods this codebase actually uses.
declare module 'qrcode-svg' {
  interface QRCodeOptions {
    content: string;
    padding?: number;
    width?: number;
    height?: number;
    color?: string;
    background?: string;
    ecl?: 'L' | 'M' | 'Q' | 'H';
  }

  class QRCode {
    constructor(options: QRCodeOptions | string);
    svg(): string;
  }

  export = QRCode;
}
