import {createFileRoute} from '@tanstack/react-router';
import {getPhoto,uploadPhoto} from '../../terrain/api/api.server';
// @ts-ignore route generation and CI tsc start concurrently
export const Route=createFileRoute('/api/photos')({server:{handlers:{GET:({request}:{request:Request})=>getPhoto(request),POST:({request}:{request:Request})=>uploadPhoto(request)}}});
