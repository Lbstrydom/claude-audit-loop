# Project Guidelines

## Architecture

The system uses a modular architecture with separate services for authentication,
data processing, notification delivery, search indexing, and the frontend rendering
layer. Each service communicates through well-defined REST APIs with JSON payloads
and follows event-driven patterns for asynchronous operations. The authentication
service issues JWT tokens that are verified by all downstream services using shared
middleware. Database access is handled through a shared ORM layer with connection
pooling, query optimization, prepared statements, and transaction management to
prevent N+1 query patterns and ensure data consistency across service boundaries.
The frontend uses server-side rendering with progressive hydration for optimal
performance, SEO compatibility, and accessibility compliance. Monitoring is provided
through structured logging, distributed tracing with OpenTelemetry, and real-time
alerting via PagerDuty integration. Deployment follows a blue-green strategy with
automated rollback capabilities and comprehensive health checking across all
microservice endpoints and database connections.
