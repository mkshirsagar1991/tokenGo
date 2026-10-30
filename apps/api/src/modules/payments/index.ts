// Public API of the payments module.
export { PaymentsModule } from './payments.module';
export { PaymentRecoveryService } from './application/payment-recovery.service';
// The in-database simulator. Exported for the worker's recovery loop wiring and for tests; refused in production by config.
export { SandboxPaymentProvider } from './infrastructure/sandbox.provider';
export { PaymentProvider } from './domain/payment-provider';
export type { ProviderPayment, ProviderRefund } from './domain/payment-provider';
// Razorpay (TEST MODE ONLY). Exported so tests can drive webhooks; configuration refuses live keys and refuses it in production.
export { RazorpayPaymentProvider } from './infrastructure/razorpay.provider';
