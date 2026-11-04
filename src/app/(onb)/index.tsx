import { Redirect } from 'expo-router';
import { useApp } from '../../store/app';
export default function OnbIndex() {
  const me = useApp(s => s.me);
  return <Redirect href={me?.profileComplete ? '/keys' : '/profile'} />;
}
