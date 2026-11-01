import { ParseUUIDPipe } from '@nestjs/common';
import { ValidationException } from '../../domain/exceptions/app.exception.js';

/** `@Param('id', uuidParam('id'))`: a malformed id is a field-level 400, not a 404 or a database error. */
export const uuidParam = (field: string) =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new ValidationException([{ field, code: 'Pattern' }]),
  });
