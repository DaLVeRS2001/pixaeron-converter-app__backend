# Backend Endpoints Schemas

Production request and response contracts for the backend endpoints.

This is a planning document only. It does not define database schema, framework code, controllers, DTO classes, or validation decorators.

## Schema Conventions

- `uuid`: string UUID.
- `email`: normalized email string.
- `isoDate`: ISO 8601 datetime string.
- `int`: integer number.
- `decimal`: number with fractional support.
- `url`: absolute URL string.
- `nullable<T>`: value can be `null`.
- All authenticated endpoints require `Authorization: Bearer <accessToken>`.
- Error responses should use one shared shape:

```ts
type ApiError = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
};
```

## Shared Schemas

```ts
type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: int;
};

type User = {
  id: uuid;
  fullName: string;
  email: email;
  displayName: nullable<string>;
  avatarUrl: nullable<url>;
  emailVerified: boolean;
  planCode: string;
  createdAt: isoDate;
};

type AuthSession = {
  user: User;
  tokens: AuthTokens;
};

type FileStatus = "pending" | "processing" | "done" | "failed" | "rejected";
type ProcessingType = "conversion" | "compression";
type ProcessingMode = "client" | "server";
type ImageFormat = "png" | "jpg" | "jpeg" | "webp" | "avif" | "svg" | "tiff";

type FileAsset = {
  id: uuid;
  ownerId: uuid;
  fileName: string;
  originalFormat: string;
  outputFormat: nullable<string>;
  operationType: ProcessingType;
  status: FileStatus;
  originalSizeBytes: int;
  finalSizeBytes: nullable<int>;
  savedPercent: nullable<decimal>;
  width: nullable<int>;
  height: nullable<int>;
  favorite: boolean;
  errorCode: nullable<string>;
  errorMessage: nullable<string>;
  createdAt: isoDate;
  updatedAt: isoDate;
  expiresAt: nullable<isoDate>;
};

type ProcessingJob = {
  id: uuid;
  type: ProcessingType;
  mode: ProcessingMode;
  status: FileStatus;
  progressPercent: int;
  sourceFileIds: uuid[];
  outputFileIds: uuid[];
  errorCode: nullable<string>;
  errorMessage: nullable<string>;
  createdAt: isoDate;
  updatedAt: isoDate;
};

type PaginationMeta = {
  page: int;
  limit: int;
  total: int;
  totalPages: int;
};
```

## Auth

### `POST /auth/signup`

Request:

```ts
{
  fullName: string;
  email: email;
  password: string;
  captchaToken: string;
  acceptedTerms: boolean;
  acceptedPrivacyPolicy: boolean;
  marketingConsent?: boolean;
}
```

Response `201`:

```ts
{
  user: User;
  emailConfirmationRequired: boolean;
}
```

### `POST /auth/login`

Request:

```ts
{
  email: email;
  password: string;
  captchaToken?: string;
  rememberMe?: boolean;
}
```

Response `200`:

```ts
AuthSession
```

### `POST /auth/google`

Request:

```ts
{
  authorizationCode: string;
  redirectUri: url;
}
```

Response `200`:

```ts
AuthSession
```

### `POST /auth/logout`

Request:

```ts
{
  refreshToken?: string;
  allDevices?: boolean;
}
```

Response `204`: no body.

### `POST /auth/refresh`

Request:

```ts
{
  refreshToken: string;
}
```

Response `200`:

```ts
AuthTokens
```

### `GET /auth/me`

Request: no body.

Response `200`:

```ts
{
  user: User;
}
```

### `POST /auth/email/confirm`

Request:

```ts
{
  token: string;
}
```

Response `200`:

```ts
{
  user: User;
  emailVerified: true;
}
```

### `POST /auth/email/resend`

Request:

```ts
{
  email: email;
  captchaToken?: string;
}
```

Response `202`:

```ts
{
  resendAvailableAt: isoDate;
}
```

### `POST /auth/password/forgot`

Request:

```ts
{
  email: email;
  captchaToken: string;
}
```

Response `202`:

```ts
{
  accepted: true;
  retryAvailableAt?: isoDate;
}
```

### `POST /auth/password/reset`

Request:

```ts
{
  token: string;
  newPassword: string;
}
```

Response `204`: no body.

## Dashboard

### `GET /dashboard/summary`

Request: no body.

Response `200`:

```ts
{
  user: User;
  stats: {
    totalConverted: int;
    processedStorageBytes: int;
    userConversions: int;
    compressedFiles: int;
    savedStorageBytes: int;
  };
  storage: {
    usedBytes: int;
    limitBytes: int;
    usedPercent: decimal;
  };
  recentFiles: FileAsset[];
  mostUsedFormats: Array<{
    fromFormat: string;
    toFormat: string;
    filesCount: int;
  }>;
  lastUpdatedAt: isoDate;
}
```

### `GET /dashboard/recent-files`

Query:

```ts
{
  limit?: int;
}
```

Response `200`:

```ts
{
  items: FileAsset[];
}
```

### `GET /dashboard/format-stats`

Query:

```ts
{
  range?: "7d" | "30d" | "90d" | "all";
}
```

Response `200`:

```ts
{
  items: Array<{
    fromFormat: string;
    toFormat: string;
    filesCount: int;
  }>;
}
```

## Converter

### `POST /converter/jobs`

Request:

```ts
{
  sourceFileIds: uuid[];
  targetFormat: "png" | "jpg" | "jpeg" | "webp" | "avif";
  quality?: int;
  preserveMetadata?: boolean;
  storeOutput?: boolean;
}
```

Response `202`:

```ts
{
  job: ProcessingJob;
}
```

### `GET /converter/jobs/:id`

Path:

```ts
{
  id: uuid;
}
```

Response `200`:

```ts
{
  job: ProcessingJob;
}
```

### `POST /converter/jobs/:id/cancel`

Path:

```ts
{
  id: uuid;
}
```

Request: no body.

Response `200`:

```ts
{
  job: ProcessingJob;
}
```

### `POST /converter/client-results`

Request:

```ts
{
  results: Array<{
    sourceFileName: string;
    sourceFormat: string;
    targetFormat: "png" | "jpg" | "jpeg" | "webp" | "avif";
    originalSizeBytes: int;
    finalSizeBytes: int;
    width?: int;
    height?: int;
    checksumSha256?: string;
    storeOutput?: boolean;
    uploadId?: uuid;
  }>;
}
```

Response `201`:

```ts
{
  files: FileAsset[];
  usage: UsageSummary;
}
```

## Compressor

### `POST /compressor/jobs`

Request:

```ts
{
  sourceFileIds: uuid[];
  quality: int;
  mode: "lossless" | "balanced" | "max";
  outputFormat?: ImageFormat;
  removeMetadata?: boolean;
  storeOutput?: boolean;
}
```

Response `202`:

```ts
{
  job: ProcessingJob;
}
```

### `GET /compressor/jobs/:id`

Path:

```ts
{
  id: uuid;
}
```

Response `200`:

```ts
{
  job: ProcessingJob;
}
```

### `POST /compressor/jobs/:id/cancel`

Path:

```ts
{
  id: uuid;
}
```

Request: no body.

Response `200`:

```ts
{
  job: ProcessingJob;
}
```

### `POST /compressor/client-results`

Request:

```ts
{
  results: Array<{
    sourceFileName: string;
    sourceFormat: string;
    outputFormat: ImageFormat;
    originalSizeBytes: int;
    finalSizeBytes: int;
    quality: int;
    width?: int;
    height?: int;
    checksumSha256?: string;
    storeOutput?: boolean;
    uploadId?: uuid;
  }>;
}
```

Response `201`:

```ts
{
  files: FileAsset[];
  usage: UsageSummary;
}
```

## Files / History

### `GET /files`

Query:

```ts
{
  page?: int;
  limit?: int;
  search?: string;
  format?: string;
  status?: FileStatus;
  operationType?: ProcessingType;
  favorite?: boolean;
  dateFrom?: isoDate;
  dateTo?: isoDate;
  sort?: "newest" | "oldest" | "name" | "size" | "saved";
}
```

Response `200`:

```ts
{
  items: FileAsset[];
  meta: PaginationMeta;
}
```

### `GET /files/:id`

Path:

```ts
{
  id: uuid;
}
```

Response `200`:

```ts
{
  file: FileAsset;
}
```

### `PATCH /files/:id`

Path:

```ts
{
  id: uuid;
}
```

Request:

```ts
{
  fileName?: string;
  favorite?: boolean;
}
```

Response `200`:

```ts
{
  file: FileAsset;
}
```

### `DELETE /files/:id`

Path:

```ts
{
  id: uuid;
}
```

Response `204`: no body.

### `POST /files/delete-selected`

Request:

```ts
{
  fileIds: uuid[];
}
```

Response `200`:

```ts
{
  deletedCount: int;
}
```

### `DELETE /files/history`

Query:

```ts
{
  operationType?: ProcessingType;
  before?: isoDate;
}
```

Response `200`:

```ts
{
  deletedCount: int;
}
```

### `GET /files/export.csv`

Query:

```ts
{
  search?: string;
  format?: string;
  status?: FileStatus;
  operationType?: ProcessingType;
  dateFrom?: isoDate;
  dateTo?: isoDate;
}
```

Response `200`: `text/csv` file download.

## Uploads / Downloads

### `POST /uploads/presign`

Request:

```ts
{
  fileName: string;
  contentType: string;
  sizeBytes: int;
  purpose: "source" | "output" | "avatar";
  checksumSha256?: string;
}
```

Response `201`:

```ts
{
  uploadId: uuid;
  uploadUrl: url;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: isoDate;
}
```

### `POST /uploads/complete`

Request:

```ts
{
  uploadId: uuid;
  fileName: string;
  contentType: string;
  sizeBytes: int;
  checksumSha256?: string;
  width?: int;
  height?: int;
}
```

Response `201`:

```ts
{
  file: FileAsset;
}
```

### `GET /files/:id/download-url`

Path:

```ts
{
  id: uuid;
}
```

Response `200`:

```ts
{
  downloadUrl: url;
  expiresAt: isoDate;
}
```

## Settings

### `GET /settings`

Request: no body.

Response `200`:

```ts
{
  profile: {
    fullName: string;
    email: email;
    emailVerified: boolean;
    displayName: nullable<string>;
    avatarUrl: nullable<url>;
    connectedAccounts: Array<{
      provider: "google";
      email: email;
      connected: boolean;
    }>;
  };
  preferences: UserPreferences;
  emailPreferences: EmailPreferences;
  usage: UsageSummary;
  plan: PlanSummary;
}
```

### `PATCH /settings/profile`

Request:

```ts
{
  fullName?: string;
  displayName?: string;
  avatarUploadId?: uuid;
}
```

Response `200`:

```ts
{
  user: User;
}
```

### `PATCH /settings/preferences`

Request:

```ts
UserPreferences
```

Response `200`:

```ts
{
  preferences: UserPreferences;
}
```

### `PATCH /settings/email-preferences`

Request:

```ts
EmailPreferences
```

Response `200`:

```ts
{
  emailPreferences: EmailPreferences;
}
```

### `PATCH /settings/password`

Request:

```ts
{
  currentPassword: string;
  newPassword: string;
}
```

Response `204`: no body.

### `DELETE /account`

Request:

```ts
{
  password?: string;
  confirmationText: string;
}
```

Response `204`: no body.

## Usage / Plan

```ts
type UserPreferences = {
  defaultOutputFormat: ImageFormat;
  compressionQuality: int;
  preferredFormats: ImageFormat[];
  autoOptimizeOnUpload: boolean;
};

type EmailPreferences = {
  productUpdates: boolean;
  weeklyDigest: boolean;
  marketingEmails: boolean;
  securityAlerts: boolean;
};

type UsageSummary = {
  conversionsThisMonth: int;
  conversionsLimit: int;
  storageUsedBytes: int;
  storageLimitBytes: int;
  filesStored: int;
};

type PlanSummary = {
  code: string;
  name: string;
  storageLimitBytes: int;
  conversionsPerMonth: int;
  maxFileSizeBytes: int;
  canUpgrade: boolean;
};
```

### `GET /usage/summary`

Request: no body.

Response `200`:

```ts
{
  usage: UsageSummary;
}
```

### `GET /plans/current`

Request: no body.

Response `200`:

```ts
{
  plan: PlanSummary;
}
```

### `POST /plans/upgrade-intent`

Request:

```ts
{
  targetPlanCode: string;
}
```

Response `200`:

```ts
{
  intentId: uuid;
  targetPlan: PlanSummary;
  status: "created" | "unsupported";
  message?: string;
}
```

