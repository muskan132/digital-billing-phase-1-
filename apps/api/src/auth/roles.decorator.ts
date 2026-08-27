// D-50: role gate written at the guard, generic and route-declared — not a
// hardcoded per-route check. A route with no @Roles(...) at all means
// SessionGuard enforces eligibility only, no role restriction.
import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
