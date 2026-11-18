import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    /** Identificador de correlación (header `x-request-id` o generado). */
    requestId?: string;
    /** Claims del JWT ya verificado. */
    auth?: { sub?: string; [claim: string]: unknown };
  }
}
