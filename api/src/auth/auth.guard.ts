import {Injectable, type CanActivate, type ExecutionContext} from '@nestjs/common';
import type {Request, Response} from 'express';
import {AuthService} from './auth.service';

/**
 * Resolves the session and attaches `req.user`. Applied to the photo endpoints,
 * which unconditionally require an authenticated session. The /api/terrain
 * dispatch resolves auth inline instead, to preserve the per-action gating
 * (login needs no session; `bootstrap` is allowed during force_change).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request & {user?: unknown}>();
    req.user = await this.auth.current(req, http.getResponse<Response>());
    return true;
  }
}
