import {Controller, Get, Post, Req, Res, UseGuards} from '@nestjs/common';
import type {Request, Response} from 'express';
import {AuthGuard} from '../auth/auth.guard';
import {AuthService} from '../auth/auth.service';
import {PhotosService} from './photos.service';
import {fail} from '../common/errors';
import {withUploadSlot} from '../common/upload-limiter';
import type {User} from '../domain/core';

/**
 * Photo endpoints — exact contract from api.server.ts (uploadPhoto / getPhoto /
 * fieldPhotoEndpoint). AuthGuard resolves req.user (401 on no session); POST
 * additionally enforces the origin/CSRF check, then waits for an upload slot
 * (503 + Retry-After when too many photo bodies are already being read).
 */
@Controller()
@UseGuards(AuthGuard)
export class PhotosController {
  constructor(
    private readonly auth: AuthService,
    private readonly photos: PhotosService,
  ) {}

  @Get('api/photos')
  async getPhoto(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.photos.getPhoto((req as any).user as User, req, res);
  }

  @Post('api/photos')
  async uploadPhoto(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.auth.requireOrigin(req);
    res.json(await withUploadSlot(res, () => this.photos.uploadPhoto((req as any).user as User, req)));
  }

  @Get('api/field-photos')
  async getFieldPhoto(@Req() req: Request, @Res() res: Response): Promise<void> {
    const u = (req as any).user as User;
    if (u.force_change) fail('Changez votre mot de passe.', 403);
    await this.photos.readFieldMedia(u, req, res);
  }

  @Post('api/field-photos')
  async uploadFieldPhoto(@Req() req: Request, @Res() res: Response): Promise<void> {
    const u = (req as any).user as User;
    if (u.force_change) fail('Changez votre mot de passe.', 403);
    this.auth.requireOrigin(req);
    res.json(await withUploadSlot(res, () => this.photos.uploadFieldMedia(u, req)));
  }
}
