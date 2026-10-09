/** Same-origin wake-up only. A notification never supplies identity or authority;
 * receivers must freshly verify their own session, workspace, resources and keys.
 * Sending on the mounted channel avoids echoing back into the sender's bootstrap. */
export function openSessionChannel(onChange,name='projektor-session'){
 const channel=new BroadcastChannel(name);
 channel.addEventListener('message',onChange);
 return {
  announce(){channel.postMessage({changed:true});},
  close(){channel.removeEventListener('message',onChange);channel.close();},
 };
}
