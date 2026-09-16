import { useState } from 'react';
import { UserRound } from 'lucide-react';

interface Props {
  src?: string;
  alt: string;
  platform?: string;
}

function AvatarSource({ src, alt }: Props) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <UserRound size={20} role="img" aria-label={`${alt}占位`} />;
  return <img src={src} alt={alt} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export default function AccountAvatar(props: Props) {
  const src = props.platform === 'weibo' && props.src ? `/api/platforms/weibo/avatar?url=${encodeURIComponent(props.src)}` : props.src;
  // A new address starts a fresh attempt; failed URLs do not loop on re-renders.
  return <AvatarSource key={src || ''} src={src} alt={props.alt} />;
}
