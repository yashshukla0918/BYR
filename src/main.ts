import { AppController } from './app/app-controller';
import { AppErrorBoundary } from './errors/error-boundary';
import './styles/main.scss';

const boundary = new AppErrorBoundary();
boundary.install();
const controller = new AppController(boundary);
void boundary.run('Workspace startup', () => controller.start());
