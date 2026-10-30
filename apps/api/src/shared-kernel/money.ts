/**
 * Money — integer minor units (e.g. paise for INR). Never a JS float (requirements §11).
 * Backed by bigint so intermediate products (amount × basis points) cannot lose precision.
 */
const CURRENCY_RE = /^[A-Z]{3}$/;
const BPS_DENOMINATOR = 10_000n;

export interface MoneyJson {
  amount_minor: number;
  currency: string;
}

export class Money {
  private constructor(
    readonly minor: bigint,
    readonly currency: string,
  ) {}

  static of(minor: bigint | number, currency: string): Money {
    if (!CURRENCY_RE.test(currency)) {
      throw new RangeError(`Invalid ISO-4217 currency code: ${currency}`);
    }
    if (typeof minor === 'number') {
      if (!Number.isSafeInteger(minor)) {
        throw new RangeError('Money minor units must be a safe integer (no floats)');
      }
      return new Money(BigInt(minor), currency);
    }
    return new Money(minor, currency);
  }

  static zero(currency: string): Money {
    return Money.of(0n, currency);
  }

  /** Parses the wire format `{ amount_minor, currency }`; rejects floats and strings. */
  static fromJson(value: { amount_minor: unknown; currency: unknown }): Money {
    if (typeof value.currency !== 'string' || typeof value.amount_minor !== 'number') {
      throw new RangeError('Invalid money payload');
    }
    return Money.of(value.amount_minor, value.currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minor === other.minor) return 0;
    return this.minor < other.minor ? -1 : 1;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  gte(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  min(other: Money): Money {
    return this.compare(other) <= 0 ? this : other;
  }

  /**
   * `bps` basis points of this amount (1000 bps = 10.00%), rounded half-up.
   * Only defined for non-negative amounts; reversals are expressed as separate ledger transactions.
   */
  percentBps(bps: number): Money {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new RangeError('Basis points must be an integer in [0, 10000]');
    }
    if (this.isNegative()) {
      throw new RangeError('percentBps is not defined for negative amounts');
    }
    const scaled = this.minor * BigInt(bps);
    return new Money((scaled + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR, this.currency);
  }

  /**
   * Splits an amount into platform commission and provider net so that
   * `commission + net === this` exactly. Any rounding residual stays on the provider side (docs §B.3).
   */
  splitCommissionBps(bps: number): { commission: Money; net: Money } {
    const commission = this.percentBps(bps);
    return { commission, net: this.subtract(commission) };
  }

  toJSON(): MoneyJson {
    if (this.minor > BigInt(Number.MAX_SAFE_INTEGER) || this.minor < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError('Money amount exceeds the safe integer range for JSON');
    }
    return { amount_minor: Number(this.minor), currency: this.currency };
  }

  toString(): string {
    return `${this.minor.toString()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new RangeError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
