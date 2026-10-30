// Public API of the catalog module.
export { CatalogModule } from './catalog.module';
export { CatalogReadService } from './application/catalog-read.service';
export type { BookableService, BookableBundle } from './application/catalog-read.service';
export { MAX_SERVICES_PER_BOOKING, bundleServices } from './domain/service-bundle';
export { PolicyResolverService } from './application/policy-resolver.service';
export { splitCommission, splitRefund, refundBpsFor, customerRefundBps, combineCommission } from './domain/pricing-rules';
export type { CommissionSnapshot, CancellationSnapshot, CancellationKind, RefundTier } from './domain/pricing-rules';
