export const handlers = {
  NEXT_PIVOT: (data, { props, set }) => {
    set(props.pivot, (data.pivot + 1) % 3);
  },
  BUMP: (data, { props, set }) => {
    set(props.rows[data.pivot].price, data.price + 5);
  },
};
