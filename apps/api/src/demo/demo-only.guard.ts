import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

// The demo control panel can mint valid signed PG callbacks and post real
// invoices on demand — a genuine forgery surface if it ever reached
// production. 404, not 403: a hidden route should look absent, not
// merely locked.
@Injectable()
export class DemoOnlyGuard implements CanActivate {
  canActivate(): boolean {
    if (process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    return true;
  }
}
