import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import {
  type FieldError,
  ValidationException,
} from '../../domain/exceptions/app.exception.js';

/** class-validator constraint name -> stable, language-neutral error code. */
const CODES: Record<string, string> = {
  isNotEmpty: 'NotBlank',
  isDefined: 'NotBlank',
  isEmail: 'Email',
  minLength: 'Size',
  maxLength: 'Size',
  length: 'Size',
  isLength: 'Size',
  min: 'Min',
  max: 'Max',
  isInt: 'Integer',
  matches: 'Pattern',
  isIn: 'OneOf',
  isEnum: 'OneOf',
  whitelistValidation: 'UnknownField',
};

export function flattenErrors(
  errors: ValidationError[],
  parent = '',
): FieldError[] {
  const out: FieldError[] = [];
  for (const e of errors) {
    const field = parent ? `${parent}.${e.property}` : e.property;
    for (const constraint of Object.keys(e.constraints ?? {})) {
      const code = CODES[constraint] ?? 'Invalid';
      if (!out.some((x) => x.field === field && x.code === code))
        out.push({ field, code });
    }
    if (e.children?.length) out.push(...flattenErrors(e.children, field));
  }
  return out;
}

/**
 * Global validation (README 5.2):
 *  - whitelist + forbidNonWhitelisted: unknown JSON fields are rejected, not ignored
 *  - transform: query strings / bodies become real typed DTO instances
 *  - failures become our ValidationException -> RFC 9457 problem+json
 */
export const createValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: false,
    exceptionFactory: (errors) =>
      new ValidationException(flattenErrors(errors)),
  });
