import { useEffect,useRef } from 'react'
export function useDialogFocus(element:HTMLElement|null,open:boolean,onClose:()=>void) {
  const close=useRef(onClose);close.current=onClose
  useEffect(()=>{
    if(!open || !element)return
    const previous=document.activeElement as HTMLElement|null
    const focusable=()=>Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(node=>!node.hidden && node.getClientRects().length>0)
    focusable()[0]?.focus()
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();close.current();return}
      if(event.key!=='Tab')return
      const items=focusable(),first=items[0],last=items.at(-1)
      if(!first){event.preventDefault();element.focus();return}
      if(event.shiftKey && (document.activeElement===first || !element.contains(document.activeElement))){event.preventDefault();last?.focus()}
      else if(!event.shiftKey && (document.activeElement===last || !element.contains(document.activeElement))){event.preventDefault();first.focus()}
    }
    document.addEventListener('keydown',keydown)
    return ()=>{document.removeEventListener('keydown',keydown);if(previous?.isConnected)previous.focus()}
  },[element,open])
}
