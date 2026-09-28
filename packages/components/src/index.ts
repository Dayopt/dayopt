// @dayopt/components — 共有 UI の単一 export 入口（内部は責務ベースの category 別に整理）

export { cn } from './cn';

// identity
export { Logo, type LogoProps } from './identity/logo';

// actions
export { Button, buttonVariants, type ButtonProps } from './actions/button';
export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from './actions/command';
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './actions/dropdown-menu';
export {
  FloatingActionBar,
  FloatingActionBarItem,
  type FloatingActionBarItemProps,
  type FloatingActionBarProps,
} from './actions/floating-action-bar';

// inputs
export { Checkbox } from './inputs/checkbox';
export {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
  FieldSupportText,
} from './inputs/field';
export { Input } from './inputs/input';
export { InputOTP, InputOTPGroup, InputOTPSlot } from './inputs/input-otp';
export { Label } from './inputs/label';
export { RadioGroup, RadioGroupItem } from './inputs/radio-group';
export { SegmentedControl } from './inputs/segmented-control';
export type { SegmentedControlOption, SegmentedControlProps } from './inputs/segmented-control';
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './inputs/select';
export { Switch } from './inputs/switch';
export { Textarea } from './inputs/textarea';

// navigation
export {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from './navigation/pagination';

// feedback
export { InlineBanner, type InlineBannerAction } from './feedback/inline-banner';
export { Skeleton } from './feedback/skeleton';
export { Toaster } from './feedback/sonner';
export { Spinner } from './feedback/spinner';

// overlays
export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './overlays/alert-dialog';
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './overlays/dialog';
export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from './overlays/drawer';
export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './overlays/popover';
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './overlays/sheet';
export { HoverTooltip } from './overlays/tooltip';

// display
export {
  Avatar,
  AvatarFallback,
  AvatarImage,
  avatarVariants,
  type AvatarProps,
} from './display/avatar';
export { Badge, badgeVariants, type BadgeProps } from './display/badge';
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './display/card';
export { Heading, Text, type HeadingProps, type TextProps } from './display/typography';

// layout
export { Container, type ContainerProps } from './layout/container';
export { ScrollArea, ScrollBar } from './layout/scroll-area';
export { Separator } from './layout/separator';

// utilities
export { overlaySurface, type OverlaySurfaceVariants } from './utilities/surface';
export { VisuallyHidden, type VisuallyHiddenProps } from './utilities/visually-hidden';
