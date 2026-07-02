# Backend Endpoints TODO

## Summary

TODO checklist of backend endpoints

## Auth

- [ ] `POST /auth/signup`
- [ ] `POST /auth/login`
- [ ] `POST /auth/google`
- [ ] `POST /auth/logout`
- [ ] `GET /auth/me`
- [ ] `POST /auth/refresh`
- [ ] `POST /auth/email/confirm`
- [ ] `POST /auth/email/resend`
- [ ] `POST /auth/password/forgot`
- [ ] `POST /auth/password/reset`

## Dashboard

- [ ] `GET /dashboard/summary`
- [ ] `GET /dashboard/recent-files`
- [ ] `GET /dashboard/format-stats`

## Converter

- [ ] `POST /converter/jobs`
- [ ] `GET /converter/jobs/:id`
- [ ] `POST /converter/jobs/:id/cancel`
- [ ] `POST /converter/client-results`

## Compressor

- [ ] `POST /compressor/jobs`
- [ ] `GET /compressor/jobs/:id`
- [ ] `POST /compressor/jobs/:id/cancel`
- [ ] `POST /compressor/client-results`

## Files / History

- [ ] `GET /files`
- [ ] `GET /files/:id`
- [ ] `PATCH /files/:id`
- [ ] `DELETE /files/:id`
- [ ] `POST /files/delete-selected`
- [ ] `DELETE /files/history`
- [ ] `GET /files/export.csv`

## Uploads / Downloads

- [ ] `POST /uploads/presign`
- [ ] `POST /uploads/complete`
- [ ] `GET /files/:id/download-url`

## Settings

- [ ] `GET /settings`
- [ ] `PATCH /settings/profile`
- [ ] `PATCH /settings/preferences`
- [ ] `PATCH /settings/email-preferences`
- [ ] `PATCH /settings/password`
- [ ] `DELETE /account`

## Usage / Plan

- [ ] `GET /usage/summary`
- [ ] `GET /plans/current`
- [ ] `POST /plans/upgrade-intent`
