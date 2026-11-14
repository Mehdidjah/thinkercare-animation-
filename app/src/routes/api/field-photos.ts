import {createFileRoute} from '@tanstack/react-router';
import {fieldPhotoEndpoint} from '../../terrain/api/api.server';
// @ts-ignore route generation and CI tsc start concurrently
export const Route=createFileRoute('/api/field-photos')({server:{handlers:{GET:({request}:{request:Request})=>fieldPhotoEndpoint(request),POST:({request}:{request:Request})=>fieldPhotoEndpoint(request)}}});
