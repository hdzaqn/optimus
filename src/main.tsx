import { createRoot } from 'react-dom/client';
import OptimusApp from './OptimusApp';

const root = document.getElementById('root');
if (!root) throw new Error('Elemento principal não encontrado.');
createRoot(root).render(<OptimusApp />);
