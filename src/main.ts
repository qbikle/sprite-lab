import './ui/tokens.css';
import { App } from './app/app';

const THEME_KEY = 'sprite-lab:v2:theme';

const saved = localStorage.getItem(THEME_KEY);
const theme = saved === 'light' || saved === 'dark'
  ? saved
  : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
document.documentElement.dataset['theme'] = theme;

const root = document.getElementById('app');
if (!root) throw new Error('missing #app root');

new App(root).mount();
