# Project: Multi-Vertical Service Marketplace Platform

Act as a Principal Software Architect, Senior Full-Stack Engineer, Mobile Application Architect, Database Architect, DevSecOps Engineer, and Payment Systems Architect.

I want you to design and build a production-ready, scalable, secure, multi-vertical service marketplace platform.

The first business category will be SALON SERVICES. The architecture must support future categories such as restaurants, doctors, clinics, pathology labs, spas, vehicle servicing, and home services without requiring a major architectural redesign.

The product will consist of:

1. Customer mobile application for Android and iOS.
2. Service provider mobile application for Android and iOS.
3. Responsive web-based administration portal.
4. Backend APIs and business services.
5. Database, payment integration, notifications, monitoring, and cloud infrastructure.

Use the attached whiteboard image as the initial business reference.

## MOST IMPORTANT INSTRUCTIONS

1. Do not start coding before completing the architecture and obtaining my approval.
2. First inspect the existing repository, if one exists. Do not overwrite or replace existing functionality without understanding it.
3. If this is a new repository, propose the project structure before creating it.
4. Build the platform as a modular monolith initially, not as a collection of microservices.
5. Keep domain modules independently structured so that individual modules can be extracted into microservices later if justified.
6. Treat the backend as the authoritative source for pricing, availability, bookings, wallet balances, payment status, permissions, and financial transactions.
7. Use a proper immutable financial ledger and a reservation/hold model. Do not implement the wallet as a simple balance deduction.
8. Do not hardcode categories, service types, commissions, cancellation rules, appointment durations, or other business configuration.
9. Prioritize transaction integrity, concurrency protection, security, privacy, auditability, and maintainability.
10. Deliver working functionality incrementally. Do not claim that a feature, integration, test, deployment, or security check is complete unless it has actually been implemented and verified.
11. Document root causes and fixes for defects, rather than reporting only that a problem has been fixed.
12. Do not make unnecessary architectural changes or rewrite working modules when a targeted change is sufficient.

# 1. PRODUCT VISION

The platform connects customers with nearby service providers.

Initial example:

A customer opens the mobile application.

The customer selects:

Category: Salon
Service: Haircut

The application displays nearby salons on a map and in a list.

Each salon listing should show:

* Business name and photos
* Rating and number of reviews
* Distance from the customer
* Address and directions
* Available services and prices
* Service duration
* Available staff or stylists
* Available appointment slots
* Next available appointment
* Opening hours and current operating status
* Relevant cancellation policy

The customer selects a salon, service, stylist if applicable, date, and available time slot.

The backend validates availability and the customer's available wallet balance.

If sufficient funds are available, the platform reserves the booking amount through a financial hold and creates a booking request.

The provider receives a notification and can approve or reject the request.

If approved, the customer attends the appointment and the provider performs the service.

After the service is completed and the applicable completion conditions are satisfied, the held funds are allocated to the provider's payable balance and the platform commission is recorded.

Provider payout is processed according to the configured payout rules and supported payment-provider capabilities.

If the booking is rejected or cancelled under applicable refund rules, the appropriate hold is released or refunded.

# 2. ARCHITECTURAL PRINCIPLES

Use the following principles throughout development:

* API-first architecture.
* Modular monolith for the initial release.
* Clear separation of domain, application, infrastructure, and presentation layers.
* Database transactions for financial and booking operations.
* Immutable financial transaction history.
* Explicit state machines for bookings, payments, holds, refunds, and payouts.
* Idempotent operations for payment and booking commands.
* Server-side authorization and validation.
* Configurable business rules.
* Event-driven processing where useful.
* Transactional outbox pattern for reliable asynchronous events.
* Automated tests and database migrations.
* Infrastructure as code where practical.
* Secure development and deployment practices.
* Comprehensive technical documentation.

Do not introduce Kafka, Kubernetes, multiple independently deployed services, or other operationally expensive infrastructure without a documented requirement.

Use a relational database as the primary source of truth.

# 3. APPLICATIONS AND TECHNOLOGY STACK

Evaluate and propose a suitable stack before implementation.

Preferred initial direction:

Mobile:

* Flutter
* Shared codebase for Android and iOS
* Separate customer and provider application experiences, with shared reusable packages where appropriate

Administration portal:

* React with Next.js and TypeScript

Backend:

* Choose one appropriate backend framework, such as NestJS with TypeScript or FastAPI with Python.
* Explain the selection based on team productivity, transaction handling, ecosystem, maintainability, and long-term support.
* Do not implement the same business rules separately in multiple backend frameworks.

Database:

* PostgreSQL
* PostGIS for geographical search where appropriate

Caching:

* Redis where justified

File and image storage:

* Private cloud object storage, such as Amazon S3

Infrastructure:

* AWS initially, with Docker-based deployments
* Infrastructure as code
* Separate development, QA/staging, and production environments

Notifications:

* Push notifications
* In-app notifications
* Email
* SMS/OTP provider abstraction

Payments:

* Payment-provider abstraction with a sandbox implementation first
* Evaluate suitable payment providers for the launch country and marketplace payment model

Maps:

* Map-provider abstraction supporting a suitable provider such as Google Maps or Mapbox

Present the final recommended stack and its trade-offs before requesting architecture approval.

# 4. USER TYPES AND AUTHORIZATION

Support the following user types:

1. Customer
2. Service provider owner
3. Service provider manager
4. Service provider staff or stylist
5. Platform administrator
6. Platform support operator
7. Finance or reconciliation operator

Implement role-based access control with granular permissions.

Do not rely on hiding buttons in the UI as an authorization mechanism.

Every protected API must enforce authorization server-side.

Provider owners must only access their own business data.

Provider staff must only access the locations, appointments, customers, and actions permitted by their assigned roles.

Financial adjustments, refunds, payout changes, and other sensitive administrative operations must have appropriate permissions and audit trails.

Support MFA for privileged accounts.

# 5. CUSTOMER MOBILE APPLICATION

Implement:

* Registration and login using mobile OTP
* Customer profile
* Location permission and manual location selection
* Service category browsing
* Nearby provider search
* Map and list views
* Filters and sorting
* Provider profile
* Service selection
* Staff selection where applicable
* Appointment availability
* Booking creation and tracking
* Wallet balance and transaction history
* Adding funds through an approved payment provider
* Booking cancellation
* Refund status
* Notifications
* Booking history
* Ratings and reviews
* Customer support and disputes
* Account deactivation and deletion workflows

The home screen should display categories configured by the administrator.

Initially, only Salon should be active. Other categories can be enabled later through administration settings.

Do not require location permission at application startup if the customer can browse using a manually selected location.

# 6. SERVICE PROVIDER MOBILE APPLICATION

Implement a separate provider experience with:

* Business registration
* Business profile management
* Location management
* Document submission and verification status
* Service and price management
* Staff management
* Staff skills and service assignments
* Working hours, breaks, and leave
* Appointment availability
* Incoming booking requests
* Booking approval and rejection
* Upcoming appointments
* Customer arrival confirmation
* Service start and completion
* Earnings and commission statements
* Payable balance
* Payout status
* Ratings and reviews
* Notifications
* Customer support and dispute management

Provider dashboard should include:

* Today's appointments
* Pending requests
* Upcoming appointments
* Completed services
* Revenue and earnings
* Outstanding payable balance
* Pending payouts
* Ratings

Providers must pass the required verification and approval checks before accepting bookings.

# 7. CONFIGURABLE MULTI-VERTICAL MODEL

Do not design the database around salon-specific entities.

Use generic entities such as:

* categories
* service_types
* providers
* provider_locations
* provider_services
* provider_staff
* staff_services
* availability_rules
* appointments
* reservations
* service_requests

Choose precise entity boundaries after the architecture review.

Examples:

Salon:
Haircut appointment with a stylist and time slot.

Doctor:
Consultation appointment with a doctor.

Pathology lab:
Test booking, potentially with a collection appointment.

Restaurant:
Table reservation for a party size and time.

Home services:
Service request with a location, time window, and assigned professional.

The initial release must fully implement the Salon appointment workflow.

Other categories must be represented through configurable metadata, service definitions, and booking policies where practical.

Do not pretend that every future vertical has identical booking requirements. Design extension points for category-specific workflows.

# 8. PROVIDER DISCOVERY AND GEOLOCATION

Implement nearby provider search based on:

* Customer location
* Search radius
* Category
* Service
* Price
* Rating
* Appointment availability
* Open/closed status
* Distance
* Staff availability

Provide:

1. Map view
2. List view
3. Provider detail page
4. Directions through the selected map provider

Use PostgreSQL/PostGIS or another justified geospatial approach.

Avoid continuous background tracking of customer locations.

Minimize the retention of precise location information.

Use location permissions only when needed and provide manual location entry.

# 9. SERVICE CATALOG AND PRICING

Each provider can configure:

* Services offered
* Service description
* Price
* Duration
* Optional buffer time
* Eligible staff
* Availability
* Service-specific cancellation policy where permitted
* Active/inactive status

Example:

ABC Salon

Haircut: ₹200, 30 minutes
Shaving: ₹100, 20 minutes
Hair coloring: ₹500, 60 minutes
Facial: ₹300, 45 minutes

These values are demo data only.

All prices and service durations must be read from trusted backend records.

The server must calculate the final booking amount.

Do not trust prices, discounts, commission values, or totals supplied by the mobile app or browser.

Record an immutable pricing snapshot against each booking so later service-price changes do not alter historical bookings.

Additional charges must require explicit customer approval before the final amount is settled.

# 10. AVAILABILITY AND APPOINTMENT ENGINE

Build a reliable availability engine.

Consider:

* Provider working hours
* Location operating hours
* Staff schedules
* Staff skills and assigned services
* Breaks and leave
* Holidays
* Existing appointments
* Service duration
* Buffer time
* Booking lead time
* Maximum advance-booking period
* Appointment expiry
* Cancellation rules
* Time zones

Store timestamps in UTC and retain the relevant business timezone for scheduling and display.

Generate available slots dynamically.

Do not treat availability shown in the UI as a guarantee.

Revalidate availability transactionally when the customer submits a booking request.

Prevent overlapping appointments using database constraints, transaction isolation, locking, or another technically justified approach.

Support simultaneous booking attempts safely.

# 11. CRITICAL WALLET AND FINANCIAL LEDGER ARCHITECTURE

This is one of the most important parts of the platform.

Do not implement the wallet using only:

wallet.balance = wallet.balance - amount

Do not transfer funds to the provider merely because a booking has been requested or approved.

Implement a ledger-based financial model with distinct concepts for:

1. Customer available balance
2. Customer held or reserved funds
3. Provider payable balance
4. Platform commission
5. Provider payout
6. Refunds and financial adjustments

Maintain an auditable ledger for all financial movements.

Suggested entities:

* wallet_accounts
* ledger_transactions
* ledger_entries
* wallet_holds
* payment_intents
* payment_transactions
* refunds
* provider_payables
* commissions
* payouts
* reconciliation_records

Finalize the exact schema during architecture design.

Every financial transaction must have:

* Unique identifier
* Account or ledger references
* Transaction type
* Amount
* Currency
* Status
* Business reference
* Booking reference when applicable
* Idempotency key
* Timestamp
* Initiating actor or system
* Related transaction reference where applicable
* Audit metadata

Financial records must not be physically deleted or silently rewritten.

Use compensating transactions to correct posted financial entries.

Use integer minor currency units for monetary calculations wherever supported by the currency model. Never use floating-point arithmetic for money.

Maintain ledger invariants and reconcile account balances against ledger entries.

# 12. WALLET HOLD AND RELEASE MODEL

Use the following financial lifecycle.

Example:

Customer available balance: ₹1,000

Haircut price: ₹200

After a successful hold:

Customer available balance: ₹800
Customer held balance: ₹200

The customer's available balance decreases, but the funds are not yet earned by the provider.

The amount remains reserved against the booking.

Booking lifecycle:

Customer selects service
↓
Backend validates price and availability
↓
Backend validates available funds
↓
Create financial hold
↓
Create booking request
↓
Provider approves or rejects
↓
Customer attends appointment
↓
Service is completed
↓
Apply configured financial settlement rules
↓
Record provider payable and platform commission
↓
Process provider payout when eligible

If the provider rejects the booking, release the hold back to the customer's available balance.

If the customer or provider cancels, apply the configured cancellation and refund policy.

A release operation must be idempotent. The same hold must never be released or settled twice.

A hold must have an explicit status, amount, booking reference, timestamps, and release/settlement references.

Prevent negative available balances unless a separately approved financial model explicitly permits them.

# 13. IMPORTANT: WALLET, PAYMENT GATEWAY, AND ESCROW DISTINCTION

Do not assume that an internal wallet ledger is legally equivalent to escrow or that holding customer funds is automatically permitted.

Before production launch, evaluate the legal, regulatory, and payment-provider requirements for the target country, including India if that is the launch market.

Determine whether the intended customer wallet must use an approved stored-value/prepaid payment arrangement or whether an alternative payment flow is required.

Design a payment abstraction that can support the approved model.

Possible models to evaluate:

A. Customer-funded wallet with reservation holds, if legally and contractually supported.

B. Per-booking payment authorization and capture, where supported by the payment provider and the applicable payment rules.

C. Another approved marketplace payment and settlement model.

Do not assume that a payment authorization can remain valid for an arbitrary appointment duration. Verify provider-specific expiry and capture rules.

Do not represent an internal ledger entry as proof that funds are held in a regulated escrow account.

Do not launch real-money wallet or provider-settlement functionality until the payment flow, fund custody, refunds, settlement, and provider payouts have been reviewed and approved for the applicable jurisdiction.

# 14. PAYMENT INTEGRATION

Implement a payment-provider interface.

Potential integrations may include Razorpay, Cashfree, Stripe, or another suitable provider, subject to country availability and marketplace capabilities.

Initially implement sandbox/test mode.

Support:

* Add-funds initiation
* Payment success, failure, and pending states
* Payment-provider transaction references
* Verified webhooks
* Refund initiation
* Refund status
* Provider settlement/payout status
* Payment reconciliation
* Duplicate callback protection
* Failed and delayed callback recovery

Never trust a client-side payment-success response.

Verify payment status server-side using provider-supported verification mechanisms.

Verify webhook signatures.

Persist webhook processing results and make webhook handlers idempotent.

Never store card security codes or unnecessary sensitive payment credentials.

# 15. BOOKING STATE MACHINE

Implement an explicit booking state machine with validated transitions.

Suggested states:

* DRAFT
* PAYMENT_PENDING
* PAYMENT_HELD
* REQUESTED
* PROVIDER_APPROVED
* PROVIDER_REJECTED
* CONFIRMED
* CUSTOMER_ARRIVED
* SERVICE_STARTED
* SERVICE_COMPLETED
* CUSTOMER_CANCELLED
* PROVIDER_CANCELLED
* EXPIRED
* DISPUTED
* CLOSED

Payment and settlement status must be modeled separately from booking status.

For example, a booking can be service-completed while financial settlement remains pending.

Do not force all booking and payment concepts into one status field.

For each transition define:

* Permitted source state
* Target state
* Authorized actor
* Preconditions
* Financial side effects
* Notifications
* Audit event
* Failure handling

Do not allow arbitrary status updates through generic CRUD APIs.

Record every significant state transition in an append-only booking event history.

# 16. END-TO-END BOOKING WORKFLOW

Implement the following customer journey.

1. Customer opens the application.
2. Customer selects Salon.
3. Customer selects Haircut.
4. Application identifies the customer's location or selected search location.
5. Nearby salons appear on a map and list.
6. Customer selects ABC Salon.
7. Customer views the price, duration, staff, and availability.
8. Customer selects a stylist and a valid time slot.
9. Backend validates the selected service, current price, provider status, staff availability, and appointment slot.
10. Backend checks the customer's available balance.
11. If funds are insufficient, display an option to add funds using the approved payment flow.
12. If funds are sufficient, create the financial hold and booking request atomically.
13. Notify the provider.
14. Provider approves or rejects the request.
15. On rejection, initiate the appropriate hold release.
16. On approval, confirm the appointment.
17. Customer visits the salon.
18. Staff verifies the booking through a secure QR code or booking PIN.
19. Staff records customer arrival.
20. Staff starts the service.
21. Staff completes the service.
22. Customer confirms any permitted additional charges, if applicable.
23. Backend validates completion and the applicable settlement conditions.
24. Record provider payable and platform commission using balanced ledger entries.
25. Release the hold through the appropriate ledger settlement operation.
26. Process provider payout according to payout rules and payment-provider capabilities.
27. Notify both parties.
28. Allow the customer to submit a review.

Do not automatically mark a service completed merely because its scheduled end time has passed.

# 17. PROVIDER APPROVAL, REJECTION, AND TIMEOUT

Provider receives a notification with:

* Customer booking reference
* Requested service
* Date and time
* Assigned or requested staff member
* Booking amount
* Relevant booking instructions

Provider can approve or reject the request.

Implement a configurable response deadline.

If the provider does not respond within the configured time:

* Expire the request when appropriate.
* Release the associated hold exactly once.
* Notify the customer.
* Record the reason and state transition.

If provider rejection occurs after approval, use the appropriate cancellation/refund rules.

Use database-backed jobs or a suitable scheduling mechanism. Do not rely on the mobile app being open for expiry processing.

# 18. CUSTOMER ARRIVAL AND SERVICE COMPLETION

Support secure booking verification through:

* QR code
* Booking PIN
* Authorized provider confirmation

Do not expose sensitive customer data in QR codes.

Use expiring or securely generated verification tokens where appropriate.

The staff application should support:

* Verify booking
* Mark customer arrived
* Start service
* Complete service

Enforce permitted transitions server-side.

Additional charges must be separately itemized and explicitly accepted by the customer before settlement.

# 19. COMMISSION, PAYABLES, AND PROVIDER PAYOUTS

Support configurable commission rules.

Example:

Service amount: ₹200
Platform commission: 10%
Provider payable: ₹180
Platform commission: ₹20

These amounts are illustrative.

Support:

* Percentage commission
* Fixed commission
* Category-specific rules
* Provider-specific rules
* Service-specific rules
* Effective dates and versioned rules where needed

Define clearly whether commission is calculated on the service price before or after discounts, taxes, and refunds.

Capture the applicable commission rule in the booking's financial snapshot.

After service completion, record the provider payable and platform commission through a consistent financial transaction.

Do not confuse provider payable balance with money already paid into the provider's bank account.

Payouts must have explicit statuses, references, reconciliation records, and retry handling.

# 20. CANCELLATIONS, REFUNDS, AND DISPUTES

Make cancellation and refund policies configurable.

Possible rules:

* Full refund before a configured deadline
* Partial refund within a configured cancellation window
* Provider cancellation
* Provider rejection
* Customer no-show
* Provider no-show
* Service not delivered
* Service partially completed
* Disputed service

Do not hardcode cancellation fees.

Support customer disputes with:

* Booking history
* Booking state transitions
* Payment and hold history
* Service details
* Evidence
* Customer/provider messages
* Administrative decision
* Refund or settlement outcome

Administrative financial decisions must be authorized and audited.

Never release or refund more than the amount permitted by the underlying financial transactions and approved policy.

# 21. ADMINISTRATION PORTAL

Create a responsive, professional administration portal.

Platform administrators should be able to manage:

* Users and roles
* Categories
* Service types
* Providers
* Provider verification
* Provider locations
* Services and pricing
* Staff and permissions
* Booking configuration
* Cancellation policies
* Commission rules
* Payment configuration
* Wallet configuration
* Notifications
* Refunds
* Disputes
* Payout monitoring
* Financial reconciliation
* Reviews
* Platform settings
* Reports
* Audit logs

Important settings must be configurable through the UI wherever practical.

Do not expose payment secrets or unrestricted financial operations to ordinary administrators.

Support maker-checker approval for sensitive actions where appropriate.

Use server-side authorization and audit sensitive configuration changes.

# 22. DATABASE DESIGN

Use PostgreSQL with appropriate indexes, foreign keys, constraints, and migrations.

Potential entities include:

Identity:

* users
* roles
* permissions
* user_roles
* customer_profiles
* provider_profiles
* provider_staff
* addresses

Catalog:

* categories
* service_types
* services
* provider_locations
* provider_services
* staff_services

Scheduling:

* working_hours
* availability_rules
* staff_leaves
* appointments
* appointment_events

Financial:

* wallet_accounts
* ledger_transactions
* ledger_entries
* wallet_holds
* payment_intents
* payment_transactions
* refunds
* commissions
* provider_payables
* payouts
* reconciliation_records

Supporting:

* reviews
* notifications
* notification_templates
* documents
* disputes
* audit_logs
* idempotency_records
* outbox_events

Treat this list as a starting point, not a mandatory one-table-per-concept design. Finalize the normalized schema during architecture review.

Use UUID identifiers where appropriate.

Use created_at and updated_at consistently.

Use appropriate soft deletion for operational records, while retaining financial and audit history according to applicable retention requirements.

Add unique constraints and indexes that support concurrency and idempotency.

Use database transactions and constraints to preserve financial integrity.

# 23. API DESIGN

Use versioned REST APIs initially.

Base path:

/api/v1/

Organize API endpoints by domain:

* /auth
* /users
* /categories
* /services
* /providers
* /provider-staff
* /availability
* /search
* /appointments
* /wallet
* /payments
* /refunds
* /payouts
* /reviews
* /notifications
* /disputes
* /admin

Implement:

* Authentication and authorization
* Input validation
* Pagination
* Filtering and sorting
* Consistent response structures
* Consistent error handling
* Rate limiting
* Request correlation IDs
* Idempotency for sensitive commands
* OpenAPI documentation

Separate command operations from read operations where it improves correctness or clarity.

Do not expose direct APIs that let clients arbitrarily set wallet balances, booking statuses, commission values, or payout outcomes.

# 24. AUTHENTICATION AND SECURITY

Implement:

* OTP authentication with throttling
* Secure token/session management
* Refresh-token rotation or another justified secure renewal model
* Session revocation
* Logout
* Password reset where applicable
* MFA for privileged accounts
* Brute-force protection
* Secure secret storage
* Encryption in transit
* Encryption for sensitive stored data where appropriate
* Input validation and output encoding
* SQL injection prevention
* XSS and CSRF protections where applicable
* IDOR prevention
* Secure file upload handling
* Dependency scanning
* Security headers
* Audit logging
* Webhook signature verification
* Rate limiting

Never log passwords, OTPs, payment secrets, access tokens, or unnecessary personal data.

Perform an OWASP-aligned security review before production deployment.

# 25. PII AND PRIVACY

Identify and classify personal data.

Potential fields:

* Name
* Phone number
* Email
* Address
* Location
* Profile photos
* Booking history
* Payment references

Implement:

* Data minimization
* Role-based data access
* Masking in logs and support views
* Configurable retention where appropriate
* Account deactivation and deletion workflows
* Data export where required
* Secure document storage
* Consent and privacy notices
* Auditable access to sensitive information

Produce a PII data-flow diagram identifying collection, storage, processing, sharing, access, retention, and deletion.

Assess applicable privacy and payment regulations for the deployment jurisdiction.

# 26. NOTIFICATION ARCHITECTURE

Create a centralized notification module.

Support:

* Push notifications
* In-app notifications
* Email
* SMS

Events include:

* Booking requested
* Booking approved
* Booking rejected
* Booking expired
* Booking cancelled
* Appointment reminder
* Customer arrived
* Service started
* Service completed
* Hold created
* Hold released
* Refund processed
* Provider payable recorded
* Provider payout status changed
* Review requested

Use an event/outbox approach so notification failures do not corrupt booking or financial transactions.

Implement retries and delivery status tracking.

Do not send duplicate notifications unnecessarily when events are retried.

# 27. EVENT PROCESSING AND MODULAR MONOLITH

Keep the initial backend in one deployable application, separated into domain modules.

Suggested modules:

* Identity and Access
* Customer
* Provider Management
* Catalog
* Geolocation and Search
* Availability
* Booking
* Wallet and Ledger
* Payments
* Settlement and Payouts
* Notifications
* Reviews
* Disputes
* Administration
* Reporting
* Audit

Each module should expose clear interfaces.

Do not allow unrelated modules to modify another module's internal tables or business state arbitrarily.

Use a transactional outbox for reliable publication of domain events.

Examples:

BookingRequested
BookingApproved
BookingRejected
BookingCancelled
ServiceCompleted
HoldCreated
HoldReleased
ProviderPayableRecorded
PayoutProcessed

Start with a database-backed outbox and background workers.

Consider an external message broker only when the actual requirements justify it.

# 28. FAILURE HANDLING AND CONCURRENCY

Explicitly handle:

* Insufficient balance
* Duplicate booking submissions
* Simultaneous bookings for the same staff/time
* Payment timeout
* Delayed payment webhook
* Duplicate webhook
* Provider rejection
* Provider timeout
* Customer cancellation
* Provider cancellation
* Staff unavailability
* App closure during booking
* Booking creation failure
* Hold creation failure
* Notification delivery failure
* Duplicate service-completion request
* Duplicate hold release
* Refund failure
* Payout failure
* Database transaction failure
* Background job retry

Use database transactions, constraints, appropriate locking, idempotency keys, and compensating transactions.

Do not assume that two separate API requests cannot execute simultaneously.

Never create a confirmed booking if its required financial reservation has failed.

Never leave a booking and financial hold inconsistent without a defined recovery and reconciliation mechanism.

Do not rely on distributed transactions across the payment gateway and database. Design explicit pending states, verified callbacks, reconciliation, and recovery workflows.

# 29. TESTING

Implement automated tests for:

* Authentication and authorization
* Provider onboarding
* Service catalog
* Search and geolocation
* Availability
* Booking creation
* Booking approval and rejection
* Booking expiry
* Wallet ledger
* Holds and releases
* Payment webhooks
* Refunds
* Commission calculations
* Provider payables
* Payouts
* Notifications
* Reviews
* Disputes
* Audit logs
* Security controls

Critical financial tests:

1. Two simultaneous requests attempt to book the same slot.
2. Two requests attempt to spend the same available wallet funds.
3. The same booking request is submitted twice.
4. The same payment webhook arrives twice.
5. A hold-release command is executed twice.
6. A service-completion command is executed twice.
7. A provider payout request is retried after a timeout.
8. Booking creation fails during financial reservation.
9. Financial reservation succeeds but a later operation fails.
10. A refund and settlement attempt conflict.

Verify ledger invariants, account balances, state transitions, and recovery behavior.

Use unit, integration, API, security, and end-to-end tests.

Do not mark a phase complete when its critical tests are failing.

# 30. REPORTING AND AUDIT

Implement reports for:

* Customer registrations
* Provider registrations
* Bookings by status
* Completed and cancelled bookings
* Popular services
* Provider performance
* Customer ratings
* Payment transactions
* Wallet holds and releases
* Refunds
* Platform commissions
* Provider payables
* Payouts
* Reconciliation exceptions

Support date-range filters and export where authorized.

Audit sensitive changes with actor, action, entity, timestamp, request reference, and relevant before/after values.

Never include credentials or unnecessary PII in audit metadata.

# 31. CLOUD INFRASTRUCTURE AND DEPLOYMENT

Design an AWS deployment architecture appropriate for the initial release.

Potential components:

* CloudFront for appropriate web assets
* Application Load Balancer
* Containerized backend application
* Background workers
* PostgreSQL through an appropriate managed database service
* Redis where justified
* S3 for private file storage
* Secrets Manager
* CloudWatch and structured application logs
* Monitoring and alerting
* Backup and recovery
* WAF and appropriate network security controls

Do not introduce unnecessary services just because they are available.

Document:

* Network boundaries
* IAM permissions
* Secret management
* Encryption
* Database backups
* Disaster recovery
* Scaling approach
* Deployment rollback
* Cost assumptions

Create separate development, QA/staging, and production environments.

Provide Docker configuration and infrastructure-as-code templates as appropriate.

Never commit production credentials.

# 32. CI/CD AND QUALITY

Create a pipeline covering:

Code validation
→ Linting and formatting
→ Unit tests
→ Integration tests
→ Dependency and security scans
→ Build
→ QA deployment
→ Smoke tests
→ Approval
→ Production deployment

Use automated database migrations.

Document rollback and recovery procedures.

Do not run destructive migrations against production without an approved deployment procedure.

# 33. UI/UX REQUIREMENTS

Customer application:

* Clean, modern, consumer-focused UI
* Map-first discovery
* Clear prices and ratings
* Visible availability
* Minimal booking steps
* Transparent wallet balance and held amount
* Clear booking and refund statuses

Provider application:

* Operational dashboard
* Today's schedule
* Pending requests
* Clear approve/reject actions
* Staff availability
* Service-completion controls
* Earnings and payout transparency

Admin portal:

* Professional enterprise interface
* Responsive layouts
* Configurable tables and filters
* Dashboards
* Financial reconciliation
* Audit history
* Role-specific navigation

Avoid excessive whitespace, generic-looking dashboards, and unnecessary steps.

Use accessible components and consistent design tokens.

# 34. DEMO DATA

Create development-only seed data for:

Category: Salon

Providers:

* ABC Salon
* XYZ Salon
* Style Studio

Services:

* Haircut: ₹200
* Shaving: ₹100
* Hair Coloring: ₹500
* Facial: ₹300

Create several stylists with different skills, schedules, breaks, and appointment availability.

Create demo customers and bookings.

Seed wallet funds only in the development environment through clearly identified test transactions.

Do not create fake successful production payments or fake settlement records.

Provide documented demo accounts without hardcoding real credentials into the application.

# 35. DOCUMENTATION

Maintain these documents:

* README.md
* ARCHITECTURE.md
* DATABASE.md
* API.md
* SECURITY.md
* PII-DATA-FLOW.md
* DEPLOYMENT.md
* BOOKING-STATE-MACHINE.md
* WALLET-AND-LEDGER.md
* PAYMENT-INTEGRATION.md
* REFUNDS-AND-PAYOUTS.md
* TESTING.md
* ADMIN-GUIDE.md
* CUSTOMER-GUIDE.md
* PROVIDER-GUIDE.md
* OPERATIONS-RUNBOOK.md
* DISASTER-RECOVERY.md
* ADR/

Include architecture diagrams, ERDs, sequence diagrams, and state-transition diagrams.

Record significant architectural decisions as Architecture Decision Records.

# 36. IMPLEMENTATION PHASES

After architecture approval, deliver the platform incrementally.

Phase 0: Discovery and architecture

* Inspect repository and existing infrastructure, if present.
* Confirm requirements and assumptions.
* Produce architecture, ERD, state machines, security design, and effort estimate.
* Identify payment-provider and regulatory dependencies.

Phase 1: Foundation

* Repository and project structure
* Authentication
* RBAC
* Database migrations
* Categories and services
* Provider registration
* Locations and staff
* CI/CD foundation

Phase 2: Customer discovery

* Location handling
* Map integration
* Provider search
* Provider profile
* Service catalog
* Availability

Phase 3: Booking engine

* Slot validation
* Booking creation
* Provider approval/rejection
* Booking state machine
* Booking expiry
* Concurrency controls

Phase 4: Financial foundation

* Ledger
* Wallet accounts
* Holds and releases
* Payment-provider abstraction
* Sandbox payment integration
* Idempotent webhooks
* Refund processing
* Commission accounting
* Provider payable accounting
* Reconciliation

Do not enable production money movement before the required compliance and payment-provider reviews.

Phase 5: Provider operations

* Provider dashboard
* Staff schedules
* Appointment management
* Arrival verification
* Service start and completion

Phase 6: Notifications

* Push
* Email
* SMS
* In-app
* Reliable event/outbox processing

Phase 7: Reviews and disputes

* Ratings
* Reviews
* Customer support
* Dispute workflow

Phase 8: Admin portal and reporting

* Configurable settings
* Provider verification
* Financial administration
* Reconciliation
* Reports
* Audit logs

Phase 9: Security and performance

* OWASP-aligned assessment
* PII review
* Concurrency testing
* Load testing
* Recovery testing
* Accessibility checks

Phase 10: Production readiness

* Production infrastructure
* CI/CD
* Backups
* Monitoring
* Operational runbooks
* App-store preparation
* Production launch checklist

For every phase, define acceptance criteria before implementation.

# 37. DEVELOPMENT WORKING RULES

Before changing code:

1. Inspect the relevant modules and dependencies.
2. Identify the root cause or implementation gap.
3. Propose the smallest sound architectural change.
4. Identify database, API, UI, security, and backward-compatibility impacts.
5. Add or update tests.
6. Implement the change.
7. Run relevant automated tests and validation.
8. Review logs and error handling.
9. Update documentation.
10. Report the outcome accurately.

For defects, provide:

* Root cause
* Files/modules affected
* Fix applied
* Database changes
* Security implications
* Tests executed
* Test results
* Deployment considerations
* Remaining risks

Do not fabricate test results.

Do not silently change unrelated modules.

Do not store secrets in source control.

Do not implement placeholder functionality and describe it as production-ready.

# 38. REQUIRED FIRST RESPONSE

Do not write application implementation code in your first response.

First provide a complete architecture proposal containing:

A. Requirements, assumptions, and open questions

B. Recommended technology stack and trade-offs

C. High-level system architecture

D. Modular monolith boundaries and dependency rules

E. Customer and provider application architecture

F. Administration portal architecture

G. Database ERD

H. Provider search and availability design

I. Booking state machine

J. Wallet ledger and hold/release design

K. Payment, commission, payable, refund, and payout flows

L. Concurrency and idempotency strategy

M. Security architecture

N. PII data-flow architecture

O. API design and endpoint groups

P. AWS deployment architecture

Q. CI/CD and environment strategy

R. Testing and observability strategy

S. Third-party dependencies and estimated costs

T. Delivery phases, dependencies, and effort estimates

U. Key technical, operational, regulatory, and financial risks

V. Acceptance criteria for the first working release

Use Mermaid diagrams where appropriate.

Clearly distinguish confirmed requirements, recommendations, assumptions, and decisions that require my approval.

For the financial model, explain how the proposed ledger and payment-provider integration preserve the distinction between customer available funds, held funds, provider payables, platform commission, and completed payouts.

Identify any payment-provider limitations or regulatory questions that must be resolved before production.

Wait for my approval before starting implementation.

# 39. FINAL OBJECTIVE

Build a secure, maintainable, production-ready service marketplace with Salon as the first fully implemented category.

The initial release must support the complete customer journey:

Discover nearby salons
→ Select service and time
→ Validate available funds
→ Reserve the required amount
→ Request booking
→ Provider approval
→ Customer arrival
→ Service completion
→ Financial settlement
→ Provider payout
→ Customer review

The platform must preserve financial integrity, prevent double bookings and duplicate transactions, provide transparent booking and payment states, and support future categories through configuration and well-defined extension points.

Begin by reviewing the architecture requirements and preparing the proposal. Do not begin coding until I approve it.
