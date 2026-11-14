import {createFileRoute} from '@tanstack/react-router';
import {getTerrain,postTerrain} from '../../terrain/api/api.server';
// @ts-ignore route generation and CI tsc start concurrently
export const Route=createFileRoute('/api/terrain')({server:{handlers:{GET:({request}:{request:Request})=>getTerrain(request),POST:({request}:{request:Request})=>postTerrain(request)}}});
