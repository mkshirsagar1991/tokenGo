// Public API of the audit module (leaf module: depends on shared-kernel only).
export { AuditModule } from './audit.module';
export { AuditService, sanitizeAuditData } from './application/audit.service';
export type { AuditEntry } from './application/audit.service';
