/**
 * T06287：Design System 组件库统一出口。
 * 业务代码只从这里导入原语，禁止深引具体文件，便于后续替换实现。
 */
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export { IconButton, type IconButtonProps } from './IconButton';
export { Input, type InputProps, type InputSize } from './Input';
export { Table, type TableColumn, type TableDensity, type TableProps } from './Table';
export { Card, type CardPadding, type CardProps, type CardVariant } from './Card';
export { Badge, type BadgeProps, type BadgeSize, type BadgeTone } from './Badge';
export { Skeleton, type SkeletonProps } from './Skeleton';
export { EmptyState, type EmptyStateAction, type EmptyStateProps } from './EmptyState';
