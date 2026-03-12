import { useState } from 'react';

export const useDraggable = (initialOffset = { x: 0, y: 0 }) => {
    const [offset, setOffset] = useState(initialOffset);
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

    const onPointerDown = (e) => {
        if (e.button !== 0) return;
        const target = e.target;
        if (target.tagName === 'BUTTON' || target.tagName === 'INPUT' || target.closest('button') || target.closest('input')) return;
        
        setIsDragging(true);
        setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
        e.currentTarget.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e) => {
        if (!isDragging) return;
        setOffset({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    };

    const onPointerUp = (e) => {
        setIsDragging(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    };

    return { 
        offset, 
        isDragging,
        dragProps: {
            onPointerDown,
            onPointerMove,
            onPointerUp,
            style: { cursor: isDragging ? 'grabbing' : 'grab' }
        }
    };
};
