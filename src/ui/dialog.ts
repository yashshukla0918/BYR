export class DialogService {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLElement;
  private readonly description: HTMLElement;
  private readonly fieldLabel: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly confirmButton: HTMLButtonElement;

  constructor() {
    this.dialog = requiredElement<HTMLDialogElement>('#app-dialog');
    this.title = requiredElement('#dialog-title');
    this.description = requiredElement('#dialog-description');
    this.fieldLabel = requiredElement('#dialog-field-label');
    this.input = requiredElement<HTMLInputElement>('#dialog-input');
    this.confirmButton = requiredElement<HTMLButtonElement>('#dialog-confirm');
  }

  askName(title: string, description: string, initialValue = ''): Promise<string | null> {
    return new Promise((resolve) => {
      this.configure(title, description, true, 'Continue');
      this.input.value = initialValue;
      this.dialog.addEventListener('close', () => resolve(this.dialog.returnValue === 'confirm' ? this.input.value.trim() : null), { once: true });
      this.dialog.showModal();
      this.input.focus(); this.input.select();
    });
  }

  inform(title: string, description: string, confirmLabel = 'Got it'): Promise<void> {
    return new Promise((resolve) => {
      this.configure(title, description, false, confirmLabel);
      this.dialog.addEventListener('close', () => resolve(), { once: true });
      this.dialog.showModal();
    });
  }

  private configure(title: string, description: string, showInput: boolean, confirmLabel: string): void {
    this.title.textContent = title;
    this.description.textContent = description;
    this.fieldLabel.hidden = !showInput;
    this.input.required = showInput;
    this.confirmButton.textContent = confirmLabel;
  }
}

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required UI element is missing: ${selector}`);
  return element;
}
