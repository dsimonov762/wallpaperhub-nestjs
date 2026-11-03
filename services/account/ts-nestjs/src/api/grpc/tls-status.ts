import { Injectable } from '@nestjs/common';
import type { TlsInfo } from './tls.js';

/** What the running gRPC server learned about its own certificates; read by the management port. */
@Injectable()
export class GrpcTlsStatus {
  private info?: TlsInfo;
  set(info: TlsInfo | undefined): void {
    this.info = info;
  }
  get(): TlsInfo | undefined {
    return this.info;
  }
}
