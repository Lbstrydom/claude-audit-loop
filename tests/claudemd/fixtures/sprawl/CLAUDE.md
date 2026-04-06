# Very Large Project Guidelines

This is a very large CLAUDE.md file that exceeds the 3KB size budget.
It contains extensive inline documentation that should be extracted.

## Architecture Details

The system uses a microservices architecture with the following components:
- API Gateway (Node.js, Express)
- Auth Service (Node.js, Passport)
- Data Service (Python, FastAPI)
- ML Pipeline (Python, scikit-learn, TensorFlow)
- Frontend (React, TypeScript, Tailwind)
- Database (PostgreSQL, Redis)
- Message Queue (RabbitMQ)
- Search Engine (Elasticsearch)

### API Gateway

The API gateway handles all incoming requests and routes them to the
appropriate microservice. It performs rate limiting, authentication
verification, request validation, and response transformation.

Configuration is managed through environment variables and a YAML
configuration file at `config/gateway.yml`.

### Auth Service

The authentication service manages user sessions, JWT token issuance
and verification, OAuth2 integration with Google and GitHub, password
hashing with bcrypt, and multi-factor authentication via TOTP.

### Data Service

The data service provides CRUD operations for all domain entities.
It uses SQLAlchemy ORM with PostgreSQL and implements the repository
pattern for data access abstraction.

### ML Pipeline

The machine learning pipeline processes user data for recommendations.
It runs as a batch job every 6 hours and updates the recommendation
cache in Redis.

## Database Schema

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  category_id INTEGER REFERENCES categories(id)
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  total DECIMAL(10,2) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending'
);
```

## API Endpoints

```
GET    /api/users          - List users
POST   /api/users          - Create user
GET    /api/users/:id      - Get user
PUT    /api/users/:id      - Update user
DELETE /api/users/:id      - Delete user

GET    /api/products       - List products
POST   /api/products       - Create product
GET    /api/products/:id   - Get product
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| DATABASE_URL | Yes | PostgreSQL connection string |
| REDIS_URL | Yes | Redis connection string |
| JWT_SECRET | Yes | JWT signing secret |
| GOOGLE_CLIENT_ID | No | OAuth2 client ID |
| GITHUB_CLIENT_ID | No | OAuth2 client ID |
| ML_BATCH_INTERVAL | No | ML pipeline interval |

## Deployment

Deployed via Docker Compose in development and Kubernetes in production.
CI/CD pipeline uses GitHub Actions with the following stages:
1. Lint and type check
2. Unit tests
3. Integration tests
4. Build Docker images
5. Deploy to staging
6. Run smoke tests
7. Deploy to production

## Monitoring

- Prometheus for metrics collection
- Grafana for dashboards
- PagerDuty for alerting
- ELK stack for log aggregation
