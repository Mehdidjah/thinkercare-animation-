import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Outlet,createRootRouteWithContext,HeadContent,Scripts} from '@tanstack/react-router';
import {type ReactNode} from 'react';
import appCss from '../styles.css?url';
import meta from '../app-meta.json';
export const Route=createRootRouteWithContext<{queryClient:QueryClient}>()({
 head:()=>({meta:[{charSet:'utf-8'},{name:'viewport',content:'width=device-width, initial-scale=1'},{title:meta.og_title},{name:'description',content:meta.og_description},{name:'robots',content:'noindex, nofollow, noarchive'},{property:'og:title',content:meta.og_title},{property:'og:description',content:meta.og_description},{property:'og:image',content:meta.og_image_url}],links:[{rel:'stylesheet',href:appCss},{rel:'icon',href:'/assets/favicon.svg'},{rel:'canonical',href:'https://thinkercare-terrain.higgsfield.app/'}]}),
 shellComponent:({children}:{children:ReactNode})=><html lang="fr"><head><HeadContent/></head><body>{children}<Scripts/></body></html>,
 component:Root,
 notFoundComponent:()=> <main className="error-page"><span className="wordmark">thinkercare</span><h1>Cette page n’existe pas.</h1><a href="/">Retour au terrain</a></main>,
 errorComponent:()=> <main className="error-page"><span className="wordmark">thinkercare</span><h1>La page n’a pas pu charger.</h1><p>Vos données déjà enregistrées sont conservées.</p><a href="/">Réessayer</a></main>
});
function Root(){const {queryClient}=Route.useRouteContext();return <QueryClientProvider client={queryClient}><Outlet/></QueryClientProvider>;}
