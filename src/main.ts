import { mount } from 'svelte';
import './app.css';
import Shell from './platform/Shell.svelte';
import { updates } from './platform/updates.svelte';

const app = mount(Shell, { target: document.getElementById('app')! });

// After the mount and never awaited. Whether this app can work offline has
// nothing to do with whether it can start, and the worker's first install
// fetches the entire bundle — that must not race the first paint.
updates.register();

export default app;
