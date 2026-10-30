# ADR-0006: Scoped RBAC with object-level checks and 404/403 IDOR policy

- **Status:** Accepted (requirements §4; proposal §M.1)
- **Date:** 2026-10-06

## Decision
- Permissions are fixed strings `resource:action` stored in `identity.permissions`; roles bundle them; **assignments are scoped** (`PLATFORM` | `PROVIDER` | `LOCATION`). A `PLATFORM` grant covers everything, `PROVIDER` covers that provider and its locations, `LOCATION` covers exactly one location. The role's declared scope type and the assignment's scope type are tied by a composite foreign key — a mismatched grant is rejected by the database (tested).
- Authentication is global and default-deny (`APP_GUARD`; routes opt out with `@Public()`). Platform-level routes declare `@RequirePlatformPermission(...)`. Object-level checks run in services (`ProviderAccessService`), never only in controllers or the UI.
- **IDOR policy:** a caller with no relationship to a provider receives **404** (identical to a non-existent id); a caller who belongs to the provider but lacks the permission receives **403**. Tested for providers, locations, services and staff.
- Request bodies are validated with `whitelist + forbidNonWhitelisted`, so clients cannot smuggle server-owned fields (`status`, `price`, `commission`, role names…). Provider status changes exist only as named commands (`/submit`, `/admin/providers/:id/approve`…), never a generic update.
- Separation of duties is encoded in the role→permission seed (e.g. support/finance cannot approve; admins cannot edit a provider's business data).

## Consequences
- Every new endpoint must state its permission and scope; the authorization matrix tests grow with it.
- Staff invitations never create accounts: an invitee must log in and accept; accepting grants only location-scoped access (tested), and removing staff revokes access in the same transaction.
