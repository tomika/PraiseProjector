import React, { useRef, useEffect } from "react";
import { useDrag, useDrop, DropTargetMonitor } from "react-dnd";
import { XYCoord } from "dnd-core";
import { PlaylistEntry } from "../../db-common/PlaylistEntry";

const ItemTypes = {
  PLAYLIST_ITEM: "playlist_item",
};

interface PlaylistItemProps {
  item: PlaylistEntry;
  index: number;
  moveItem: (dragIndex: number, hoverIndex: number) => void;
  removeItem: (index: number) => void;
  updateItem: (index: number, item: PlaylistEntry) => void;
}

const PlaylistItem: React.FC<PlaylistItemProps> = ({ item, index, moveItem, removeItem, updateItem }) => {
  const ref = useRef<HTMLDivElement>(null);

  const [, drop] = useDrop({
    accept: ItemTypes.PLAYLIST_ITEM,
    hover(item: unknown, monitor: DropTargetMonitor) {
      const draggedItem = item as { index: number };
      if (!ref.current) {
        return;
      }
      const dragIndex = draggedItem.index;
      const hoverIndex = index;

      if (dragIndex === hoverIndex) {
        return;
      }

      const hoverBoundingRect = ref.current?.getBoundingClientRect();
      const hoverMiddleY = (hoverBoundingRect.bottom - hoverBoundingRect.top) / 2;
      const clientOffset = monitor.getClientOffset();
      const hoverClientY = (clientOffset as XYCoord).y - hoverBoundingRect.top;

      if (dragIndex < hoverIndex && hoverClientY < hoverMiddleY) {
        return;
      }

      if (dragIndex > hoverIndex && hoverClientY > hoverMiddleY) {
        return;
      }

      moveItem(dragIndex, hoverIndex);
      draggedItem.index = hoverIndex;
    },
  });

  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.PLAYLIST_ITEM,
    item: () => {
      return { songId: item.songId, index };
    },
    collect: (monitor: any) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  // Connect drag and drop refs in an effect to avoid accessing refs during render
  useEffect(() => {
    drag(drop(ref));
  }, [drag, drop]);

  const opacity = isDragging ? 0 : 1;

  const handleTransposeChange = (amount: number) => {
    const newItem = item.clone();
    newItem.transpose = item.transpose + amount;
    updateItem(index, newItem);
  };

  const handleCapoChange = (amount: number) => {
    const newCapo = item.capo + amount;
    if (newCapo >= -1 && newCapo < 12) {
      const newItem = item.clone();
      newItem.capo = newCapo;
      updateItem(index, newItem);
    }
  };

  const handleTitleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newItem = item.clone();
    newItem.title = event.target.value;
    updateItem(index, newItem);
  };

  return (
    <div ref={ref} style={{ opacity }} className="playlist-item">
      <input type="text" value={item.title} onChange={handleTitleChange} aria-label="Song title" title="Edit song title" />
      <span>T:{item.transpose}</span>
      <button onClick={() => handleTransposeChange(1)} aria-label="Increase transpose" title="Increase transpose">
        +
      </button>
      <button onClick={() => handleTransposeChange(-1)} aria-label="Decrease transpose" title="Decrease transpose">
        -
      </button>
      <span>C:{item.capo > -1 ? item.capo : ""}</span>
      <button onClick={() => handleCapoChange(1)} aria-label="Increase capo" title="Increase capo">
        +
      </button>
      <button onClick={() => handleCapoChange(-1)} aria-label="Decrease capo" title="Decrease capo">
        -
      </button>
      <button onClick={() => moveItem(index, index - 1)} disabled={index === 0} aria-label="Move up" title="Move up">
        Up
      </button>
      <button onClick={() => moveItem(index, index + 1)} aria-label="Move down" title="Move down">
        Down
      </button>
      <button onClick={() => removeItem(index)} aria-label="Remove item" title="Remove item">
        X
      </button>
    </div>
  );
};

export default PlaylistItem;
