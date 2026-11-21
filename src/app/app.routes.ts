import { Routes } from '@angular/router';
import { RouteMarker } from './route-marker';

export const routes: Routes = [
  { path: '', component: RouteMarker },
  { path: 'shop', component: RouteMarker },
  { path: 'product/:slug', component: RouteMarker },
  { path: 'contact', component: RouteMarker },
  { path: 'request-quote', component: RouteMarker },
  { path: 'wholesale-register', component: RouteMarker },
  { path: 'cart', component: RouteMarker },
  { path: 'checkout', component: RouteMarker },
  { path: 'account', component: RouteMarker },
  { path: 'account/orders', component: RouteMarker },
  { path: 'search', component: RouteMarker },
  { path: 'admin', component: RouteMarker },
  { path: '**', component: RouteMarker }
];
