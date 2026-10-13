// @module browser-session
// @role composition
import {useBrowserSessionController} from './browser-session-controller';
import {BrowserSessionView} from './browser-session-view';

export function BrowserSession(){return <BrowserSessionView model={useBrowserSessionController()}/>;}
