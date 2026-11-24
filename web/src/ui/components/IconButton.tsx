/**
 * T06287：图标按钮，Button 的方形形态。
 * 必须提供 label（可读名称），图标本身 aria-hidden，避免图标按钮失去可访问名称。
 */
import type { ReactNode } from 'react';
import { Button, type ButtonProps } from './Button';

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'leftIcon' | 'rightIcon' | 'fullWidth'> {
  readonly icon: ReactNode;
  readonly label: string;
}

export function IconButton({ icon, label, className, loadingText, title, ...rest }: IconButtonProps) {
  return (
    <Button
      {...rest}
      className={['mt-icon-btn', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={title ?? label}
      loadingText={loadingText ?? label}
      leftIcon={icon}
    />
  );
}
