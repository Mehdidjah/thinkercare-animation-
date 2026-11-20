import {Controller, Get, Post, Req, Res} from '@nestjs/common';
import type {Request, Response} from 'express';
import {AuthService} from '../auth/auth.service';
import {TerrainService} from './terrain.service';
import {fail} from '../common/errors';

function searchParams(req: Request): URLSearchParams {
  return new URLSearchParams(req.originalUrl.split('?')[1] || '');
}

/**
 * GET/POST /api/terrain — exact HTTP contract from the original api.server.ts
 * (the `?action=` / `{action:…}` dispatch). Auth is resolved inline here (not
 * via a guard) to preserve per-action gating: `login` and `logout` need no
 * session, and `bootstrap` stays reachable during `force_change`.
 */
@Controller('api/terrain')
export class TerrainController {
  constructor(
    private readonly auth: AuthService,
    private readonly terrain: TerrainService,
  ) {}

  @Get()
  async get(@Req() req: Request, @Res() res: Response): Promise<void> {
    const u = await this.auth.current(req, res);
    res.json(await this.terrain.getTerrain(u, searchParams(req)));
  }

  @Post()
  async post(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.auth.requireOrigin(req);
    if (!(req.headers['content-type'] || '').includes('application/json')) fail('Format JSON requis.', 415);
    const raw = typeof req.body === 'string' ? req.body : '';
    if (raw.length > 70000) fail('Requête trop volumineuse.', 413);
    let b: any;
    try {
      b = JSON.parse(raw);
    } catch {
      fail('JSON invalide.');
    }
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail('Objet JSON requis.');

    if (b.action === 'login') {
      const login = await this.auth.login(b, req, res);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ok: true, ...await this.terrain.getTerrain(login.user, new URLSearchParams())});
      return;
    }
    // Before current(): an expired or revoked session must still be able to log out.
    if (b.action === 'logout') {
      res.status(200).json(await this.auth.logout(req, res));
      return;
    }
    const u = await this.auth.current(req, res);
    if (b.action === 'password') {
      res.json(await this.auth.changePassword(u, b, req));
      return;
    }
    if (u.force_change) fail('Changez votre mot de passe initial.', 403);
    if (b.action === 'user-password') {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await this.auth.revealPassword(u, b, req));
      return;
    }
    res.json(await this.terrain.postTerrain(u, b));
  }
}
