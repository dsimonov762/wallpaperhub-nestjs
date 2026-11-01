import { DefaultNamingStrategy, type NamingStrategyInterface } from 'typeorm';

const snake = (s: string): string =>
  s.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();

/** Maps TS camelCase properties to snake_case columns (displayName -> display_name). */
export class SnakeNamingStrategy
  extends DefaultNamingStrategy
  implements NamingStrategyInterface
{
  override columnName(
    propertyName: string,
    customName: string | undefined,
    embeddedPrefixes: string[],
  ): string {
    return snake(customName ?? [...embeddedPrefixes, propertyName].join('_'));
  }
}
